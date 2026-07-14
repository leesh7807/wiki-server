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
  applyAgentObservability(job, completed("Get-Content log.md; rg -n 'Atlas' raw/sources/atlas.md"));
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
    used: 2,
    untouched: 1,
    useRatio: 2 / 3,
  });
  assert.deepEqual(observed.otherObservedReadPaths, ["wiki/projects/expanded.md"]);
  assert.equal(observed.searchCommandCount, 3);
  assert.equal(observed.broadRootSearchCount, 1);
  assert.equal(observed.excludedPathSearchCount, 1);
  assert.equal(observed.broadExcludedPathAccessCount, 1);
  assert.equal(observed.runtimeLogVerificationCount, 1);
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

test("records targeted ingest provenance reads without treating them as excluded searches", () => {
  const job = makeJob("ingest");
  applyAgentObservability(job, {
    type: "retrieval_context",
    strategy: "wiki-graph-v1",
    command: "ingest",
    routing: { mode: "candidates", candidatePaths: ["wiki/projects/atlas.md"] },
  });
  applyAgentObservability(job, completed(
    "Get-Content raw/sources/atlas.md; Get-Content log.md -Tail 20",
  ));

  const observed = job.metrics?.retrievalObservability;
  assert.deepEqual(observed?.excludedPathAccesses, ["raw/sources/atlas.md", "log.md"]);
  assert.equal(observed?.excludedPathSearchCount, 0);
  assert.equal(observed?.broadExcludedPathAccessCount, 0);
  assert.equal(observed?.targetedProvenanceReadCount, 1);
  assert.equal(observed?.runtimeLogVerificationCount, 1);
  assert.equal(observed?.policySignals, undefined);
});

test("separates broad excluded access from bounded provenance and log verification", () => {
  const job = makeJob("ingest");
  applyAgentObservability(job, {
    type: "retrieval_context",
    strategy: "wiki-graph-v1",
    command: "ingest",
    routing: { mode: "candidates", candidatePaths: [] },
  });
  applyAgentObservability(job, completed("Get-Content raw/sources/atlas.md -TotalCount 80"));
  applyAgentObservability(job, completed("Get-Content log.md -Tail 20"));
  applyAgentObservability(job, completed("rg -n Atlas raw"));
  applyAgentObservability(job, completed("Get-Content raw/sources/*.md"));
  applyAgentObservability(job, completed("Get-Content log.md"));

  const observed = job.metrics?.retrievalObservability;
  assert.equal(observed?.targetedProvenanceReadCount, 1);
  assert.equal(observed?.runtimeLogVerificationCount, 2);
  assert.equal(observed?.excludedPathSearchCount, 1);
  assert.equal(observed?.broadExcludedPathAccessCount, 3);
  assert.equal(observed?.repeatedReadCommandCount, 2);
  assert.deepEqual(observed?.policySignals, ["excluded_path_access"]);
});

test("separates cached cumulative usage, single-call context, and command output observability", () => {
  const job = makeJob("ingest");
  applyAgentObservability(job, tokenUsage(20_000, 8_000, 20_500, 19_000, 20_000));
  applyAgentObservability(job, tokenUsage(150_000, 140_000, 152_000, 145_000, 147_000));
  applyAgentObservability(job, completed("Get-Content wiki/projects/a.md", "x".repeat(20_000)));
  applyAgentObservability(job, appServerCompleted("git diff --stat", "summary"));

  assert.deepEqual(job.metrics?.executionObservability, {
    evidence: "best_effort_agent_events",
    tokenUsageUpdateCount: 2,
    cachedInputTokensHighWater: 140_000,
    nonCachedInputTokensHighWater: 12_000,
    maxSingleCallInputTokens: 145_000,
    maxSingleCallTotalTokens: 147_000,
    modelContextWindow: 258_400,
    completedCommandCount: 2,
    uniqueCompletedCommandCount: 2,
    repeatedCompletedCommandCount: 0,
    commandOutputCharacters: 20_007,
    commandOutputBudgetCharacters: 12_000,
    outputBudgetViolationCount: 1,
    largestCommandOutputCharacters: 20_000,
    largeCommandOutputCount: 1,
  });
  const normalized = normalizeJobMetrics({ metrics: JSON.parse(JSON.stringify(job.metrics)) });
  const cloned = cloneJobMetrics(normalized);
  assert.deepEqual(cloned.executionObservability, job.metrics?.executionObservability);
  assert.notEqual(cloned.executionObservability, job.metrics?.executionObservability);
});

test("observes the output budget boundary and repeated completed commands", () => {
  const job = makeJob("ingest");
  applyAgentObservability(job, completed("Get-Content wiki/projects/a.md", "x".repeat(12_000)));
  applyAgentObservability(job, appServerCompleted(
    "  get-content   wiki\\projects\\a.md  ",
    "x".repeat(12_001),
  ));
  applyAgentObservability(job, completed("git diff --stat", "x".repeat(16_000)));
  applyAgentObservability(job, appServerCompleted("git diff --stat", "x".repeat(16_001)));
  applyAgentObservability(job, {
    type: "item.started",
    item: { type: "command_execution", command: "git diff --stat", output: "x".repeat(50_000) },
  });

  const observed = job.metrics?.executionObservability;
  assert.equal(observed?.completedCommandCount, 4);
  assert.equal(observed?.uniqueCompletedCommandCount, 2);
  assert.equal(observed?.repeatedCompletedCommandCount, 2);
  assert.equal(observed?.outputBudgetViolationCount, 3);
  assert.equal(observed?.largeCommandOutputCount, 1);
  assert.equal(observed?.largestCommandOutputCharacters, 16_001);
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

function tokenUsage(
  inputTokens: number,
  cachedInputTokens: number,
  totalTokens: number,
  lastInputTokens: number,
  lastTotalTokens: number,
) {
  return {
    type: "app_server_notification",
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: { inputTokens, cachedInputTokens, totalTokens },
        last: { inputTokens: lastInputTokens, totalTokens: lastTotalTokens },
        modelContextWindow: 258_400,
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
