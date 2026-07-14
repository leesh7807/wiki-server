import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "./jobTypes.js";
import { applyAgentObservability, cloneJobMetrics, normalizeJobMetrics } from "./jobMetrics.js";

test("derives candidate usage and search policy signals from completed command events", () => {
  const job = makeJob("query");
  applyAgentObservability(job, {
    type: "retrieval_context",
    strategy: "wiki-graph-v1",
    command: "query",
    routing: {
      mode: "candidates",
      candidatePaths: [
        "wiki/projects/atlas.md",
        "wiki/decisions/atlas-codeword.md",
        "wiki/concepts/untouched.md",
      ],
    },
  });
  applyAgentObservability(job, appServerCompleted("Get-Content wiki/projects/atlas.md"));
  applyAgentObservability(job, completed(
    "rg -n 'codeword' wiki/decisions/atlas-codeword.md",
    "one matching line",
  ));
  applyAgentObservability(job, completed("Get-Content wiki/projects/expanded.md"));
  applyAgentObservability(job, completed("rg -n 'Atlas' .", "x".repeat(800)));
  applyAgentObservability(job, completed("Get-Content log.md; Get-Content raw/sources/atlas.md"));
  applyAgentObservability(job, {
    type: "item.started",
    item: { type: "command_execution", command: "rg --hidden -n secret ." },
  });

  const observed = job.metrics?.retrievalObservability;
  assert.ok(observed);
  assert.deepEqual(observed.openedCandidatePaths, ["wiki/projects/atlas.md"]);
  assert.deepEqual(observed.searchedCandidatePaths, ["wiki/decisions/atlas-codeword.md"]);
  assert.deepEqual(observed.candidateCoverage, {
    offered: 3,
    opened: 1,
    searched: 1,
    untouched: 1,
  });
  assert.deepEqual(observed.otherObservedReadPaths, ["wiki/projects/expanded.md"]);
  assert.equal(observed.searchCommandCount, 2);
  assert.equal(observed.broadRootSearchCount, 1);
  assert.equal(observed.largestSearchOutputCharacters, 800);
  assert.deepEqual(observed.excludedPathAccesses, ["log.md", "raw/sources/atlas.md"]);
  assert.deepEqual(observed.policySignals, ["broad_root_search", "excluded_path_access"]);

  const serialized = JSON.parse(JSON.stringify(job.metrics)) as Job["metrics"];
  const normalized = normalizeJobMetrics({ metrics: serialized });
  const cloned = cloneJobMetrics(normalized);
  assert.deepEqual(cloned.retrievalObservability, observed);
  assert.notEqual(cloned.retrievalObservability, observed);
});

test("derives lint partition and maintenance candidate coverage", () => {
  const job = makeJob("lint");
  applyAgentObservability(job, {
    type: "retrieval_context",
    strategy: "wiki-graph-v1",
    command: "lint",
    routing: {
      mode: "partitions",
      partitionScopes: ["index.md", "wiki/maps", "wiki/projects", "wiki/sources"],
      maintenanceCandidatePaths: ["wiki/projects/large.md"],
    },
  });
  applyAgentObservability(job, completed("Get-Content index.md; Get-Content wiki/maps/home.md"));
  applyAgentObservability(job, completed("Get-Content wiki/projects/large.md"));
  applyAgentObservability(job, completed("rg -n '^sources:' wiki/sources"));

  const observed = job.metrics?.retrievalObservability;
  assert.ok(observed);
  assert.deepEqual(observed.observedPartitionScopes, [
    "index.md",
    "wiki/maps",
    "wiki/projects",
    "wiki/sources",
  ]);
  assert.deepEqual(observed.partitionCoverage, {
    offered: 4,
    observed: 4,
    untouched: 0,
  });
  assert.deepEqual(observed.observedMaintenanceCandidatePaths, ["wiki/projects/large.md"]);
  assert.deepEqual(observed.policySignals, undefined);
});

function completed(command: string, output = "") {
  return {
    type: "item.completed",
    item: {
      type: "command_execution",
      command,
      aggregated_output: output,
    },
  };
}

function appServerCompleted(command: string, output = "") {
  return {
    type: "app_server_notification",
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        command,
        aggregatedOutput: output,
      },
    },
  };
}

function makeJob(command: Job["command"]): Job {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000009",
    command,
    content: command === "lint" ? "" : "test",
    status: "running",
    createdAt: now,
    updatedAt: now,
    contentLength: command === "lint" ? 0 : 4,
    contentPreview: command === "lint" ? "" : "test",
  };
}
