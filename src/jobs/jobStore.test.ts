import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobStore } from "./jobStore.js";
import type { Job, JobEvent, RunnerResult, StoredJob } from "./jobTypes.js";

test("job event persistence is serialized under bursty agent events", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const eventCount = 500;
  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: (_job: Job, hooks) => {
      for (let index = 0; index < eventCount; index += 1) {
        hooks.onAgentEvent({ index });
      }

      return {
        done: Promise.resolve({ ok: true, result: { lastAgentMessage: "done" } }),
        cancel: () => undefined,
      };
    },
  });

  try {
    const job = store.enqueue("query", "test query");

    await eventually(() => store.getJob(job.id)?.status === "succeeded");
    await (store as unknown as { persistQueue: Promise<void> }).persistQueue;

    assert.equal(existsSync(legacyEventLogPath(jobsDir, job.id)), false);
    const lines = readFileSync(eventLogPath(jobsDir, job.id), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as { event: string; seq: number });

    assert.equal(events.filter((event) => event.event === "agent_event").length, eventCount);
    assert.equal(events.at(-1)?.event, "done");
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index].seq, events[index - 1].seq + 1);
    }
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("queue timing metrics and summary are recorded", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const runners: Array<{ resolve: (result: RunnerResult) => void }> = [];
  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: () => {
      let resolveRunner!: (result: RunnerResult) => void;
      const done = new Promise<RunnerResult>((resolve) => {
        resolveRunner = resolve;
      });
      runners.push({ resolve: resolveRunner });
      return {
        done,
        cancel: () => undefined,
      };
    },
  });

  try {
    const first = store.enqueue("query", "first query");
    const second = store.enqueue("query", "second query");
    const third = store.enqueue("query", "third query");

    assert.equal(store.getJob(first.id)?.status, "running");
    assert.equal(metricsOf(store.getJob(second.id)).queuedAheadCount, 1);
    assert.equal(metricsOf(store.getJob(third.id)).queuedAheadCount, 2);

    await delay(25);
    runners[0].resolve({ ok: true, result: { lastAgentMessage: "first done" } });
    await eventually(() => store.getJob(second.id)?.status === "running");

    const runningSecond = store.getJob(second.id);
    assert.equal(runningSecond?.startedAt !== undefined, true);
    assert.equal((metricsOf(runningSecond).queueWaitMs ?? 0) >= 20, true);

    const runningSummary = store.getMetricsSummary();
    assert.equal(runningSummary.counts.total, 3);
    assert.equal(runningSummary.counts.queued, 1);
    assert.equal(runningSummary.counts.running, 1);
    assert.equal(runningSummary.current.queued[0]?.id, third.id);
    assert.equal(runningSummary.current.queued[0]?.queuedAheadCount, 1);
    assert.equal(runningSummary.current.running?.id, second.id);

    await delay(5);
    runners[1].resolve({ ok: true, result: { lastAgentMessage: "second done" } });
    await eventually(() => store.getJob(second.id)?.status === "succeeded");

    const finishedSecond = store.getJob(second.id);
    assert.equal(finishedSecond?.finishedAt !== undefined, true);
    const finishedSecondMetrics = metricsOf(finishedSecond);
    assert.equal((finishedSecondMetrics.runMs ?? -1) >= 0, true);
    assert.equal((finishedSecondMetrics.totalMs ?? 0) >= (finishedSecondMetrics.queueWaitMs ?? 0), true);

    runners[2].resolve({ ok: true, result: { lastAgentMessage: "third done" } });
    await eventually(() => store.getJob(third.id)?.status === "succeeded");
    await (store as unknown as { persistQueue: Promise<void> }).persistQueue;

    const persisted = JSON.parse(
      readFileSync(path.join(jobsDir, `${second.id}.meta.json`), "utf8"),
    ) as Job;
    const persistedMetrics = metricsOf(persisted);
    assert.equal(persistedMetrics.queuedAheadCount, 1);
    assert.equal(typeof persistedMetrics.queueWaitMs, "number");
    assert.equal(typeof persistedMetrics.runMs, "number");
    assert.equal(typeof persistedMetrics.totalMs, "number");

    const finalSummary = store.getMetricsSummary();
    assert.equal(finalSummary.counts.terminal, 3);
    assert.equal(finalSummary.averages.samples.queueWaitMs, 3);
    assert.equal(typeof finalSummary.averages.queueWaitMs, "number");
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("lint jobs participate in the standard queue metrics and summary", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const runners: Array<{ job: Job; resolve: (result: RunnerResult) => void }> = [];
  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: (job) => {
      let resolveRunner!: (result: RunnerResult) => void;
      const done = new Promise<RunnerResult>((resolve) => {
        resolveRunner = resolve;
      });
      runners.push({ job, resolve: resolveRunner });
      return {
        done,
        cancel: () => undefined,
      };
    },
  });

  try {
    const lint = store.enqueue("lint", "");
    const query = store.enqueue("query", "queued query");

    assert.equal(lint.command, "lint");
    assert.equal(lint.contentLength, 0);
    assert.equal(lint.contentPreview, "");
    assert.equal(store.getJob(lint.id)?.status, "running");
    assert.equal(runners[0]?.job.command, "lint");
    assert.equal(runners[0]?.job.content, "");
    assert.equal(metricsOf(store.getJob(lint.id)).queuedAheadCount, 0);
    assert.equal(metricsOf(store.getJob(query.id)).queuedAheadCount, 1);

    const runningSummary = store.getMetricsSummary();
    assert.equal(runningSummary.counts.total, 2);
    assert.equal(runningSummary.counts.running, 1);
    assert.equal(runningSummary.counts.queued, 1);
    assert.equal(runningSummary.current.running?.command, "lint");
    assert.equal(runningSummary.current.queued[0]?.command, "query");

    runners[0].resolve({ ok: true, result: { lastAgentMessage: "lint done" } });
    await eventually(() => store.getJob(query.id)?.status === "running");

    const finishedLint = store.getJob(lint.id);
    assert.equal(finishedLint?.status, "succeeded");
    assert.equal(metricsOf(finishedLint).queuedAheadCount, 0);
    assert.equal(typeof metricsOf(finishedLint).queueWaitMs, "number");
    assert.equal(typeof metricsOf(finishedLint).runMs, "number");
    assert.equal(typeof metricsOf(finishedLint).totalMs, "number");

    const mixedSummary = store.getMetricsSummary();
    assert.equal(mixedSummary.counts.terminal, 1);
    assert.equal(mixedSummary.counts.running, 1);
    assert.equal(mixedSummary.current.running?.command, "query");

    runners[1].resolve({ ok: true, result: { lastAgentMessage: "query done" } });
    await eventually(() => store.getJob(query.id)?.status === "succeeded");

    const finalSummary = store.getMetricsSummary();
    assert.equal(finalSummary.counts.terminal, 2);
    assert.equal(finalSummary.averages.samples.queueWaitMs, 2);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("startup interruption preserves prior event history and advances seq", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const jobId = "11111111-1111-4111-8111-111111111111";
  const now = new Date().toISOString();
  const storedJob: StoredJob = {
    id: jobId,
    command: "query",
    status: "running",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    contentLength: 10,
    contentPreview: "old query",
    lastEventAt: now,
    metrics: {
      queuedAheadCount: 0,
    },
  };
  const priorEvents: JobEvent[] = [
    {
      seq: 7,
      at: now,
      jobId,
      event: "status",
      data: { status: "running" },
    },
    {
      seq: 8,
      at: now,
      jobId,
      event: "agent_event",
      data: { index: 1 },
    },
  ];
  writeFileSync(
    path.join(jobsDir, `${jobId}.meta.json`),
    `${JSON.stringify(storedJob, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    legacyEventLogPath(jobsDir, jobId),
    `${priorEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: () => {
      throw new Error("persisted jobs should not restart");
    },
  });

  try {
    await eventually(() => store.getJob(jobId)?.status === "interrupted");
    await (store as unknown as { persistQueue: Promise<void> }).persistQueue;

    const events = store.getEvents(jobId);
    assert.equal(existsSync(eventLogPath(jobsDir, jobId)), true);
    assert.equal(existsSync(legacyEventLogPath(jobsDir, jobId)), false);
    assert.deepEqual(
      events.slice(0, 2).map((event) => event.seq),
      [7, 8],
    );
    assert.deepEqual(
      events.slice(0, 2).map((event) => event.event),
      ["status", "agent_event"],
    );
    assert.deepEqual(
      events.slice(-2).map((event) => event.event),
      ["status", "done"],
    );
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index].seq > events[index - 1].seq, true);
    }
    assert.equal(events.at(-2)?.seq, 9);
    assert.equal(events.at(-1)?.seq, 10);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("startup interruption advances seq above all persisted active job logs", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const now = new Date().toISOString();
  const firstJobId = "22222222-2222-4222-8222-222222222222";
  const secondJobId = "33333333-3333-4333-8333-333333333333";
  const firstJob = makeStoredJob(firstJobId, "running", now);
  const secondJob = makeStoredJob(secondJobId, "queued", now);
  const firstEvents = [
    makeStoredEvent(firstJobId, 10, "status", { status: "running" }, now),
    makeStoredEvent(firstJobId, 11, "agent_event", { index: 1 }, now),
  ];
  const secondEvents = [
    makeStoredEvent(secondJobId, 20, "status", { status: "queued" }, now),
    makeStoredEvent(secondJobId, 21, "agent_event", { index: 2 }, now),
  ];

  writeStoredJob(jobsDir, firstJob);
  writeStoredJob(jobsDir, secondJob);
  writeStoredEvents(jobsDir, firstJobId, firstEvents);
  writeStoredEvents(jobsDir, secondJobId, secondEvents);

  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: () => {
      throw new Error("persisted jobs should not restart");
    },
  });

  try {
    await eventually(
      () =>
        store.getJob(firstJobId)?.status === "interrupted" &&
        store.getJob(secondJobId)?.status === "interrupted",
    );
    await (store as unknown as { persistQueue: Promise<void> }).persistQueue;

    const firstLoadedEvents = store.getEvents(firstJobId);
    const secondLoadedEvents = store.getEvents(secondJobId);
    assert.deepEqual(
      firstLoadedEvents.slice(0, 2).map((event) => event.seq),
      [10, 11],
    );
    assert.deepEqual(
      secondLoadedEvents.slice(0, 2).map((event) => event.seq),
      [20, 21],
    );

    const appendedSeqs = [...firstLoadedEvents, ...secondLoadedEvents]
      .map((event) => event.seq)
      .filter((seq) => seq > 21);
    assert.equal(appendedSeqs.length, 4);
    assert.equal(new Set(appendedSeqs).size, 4);
    assert.equal(Math.min(...appendedSeqs) > 21, true);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("legacy event log migration merges existing raw event logs", () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const jobId = "66666666-6666-4666-8666-666666666666";
  const now = new Date().toISOString();
  const storedJob = makeStoredJob(jobId, "succeeded", now);
  const firstEvent = makeStoredEvent(jobId, 1, "status", { status: "succeeded" }, now);
  const secondEvent = makeStoredEvent(jobId, 2, "done", { status: "succeeded" }, now);

  writeStoredJob(jobsDir, storedJob);
  writeCurrentStoredEvents(jobsDir, jobId, [firstEvent]);
  writeStoredEvents(jobsDir, jobId, [firstEvent, secondEvent]);

  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: () => {
      throw new Error("persisted terminal jobs should not restart");
    },
  });

  try {
    const events = store.getEvents(jobId);
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2],
    );
    assert.equal(existsSync(eventLogPath(jobsDir, jobId)), true);
    assert.equal(existsSync(legacyEventLogPath(jobsDir, jobId)), false);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("agent events derive token and file observability", async () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const manyPaths = Array.from({ length: 90 }, (_value, index) => `wiki/generated/file-${index}.md`);
  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: (_job: Job, hooks) => {
      hooks.onAgentEvent({
        type: "turn_completed",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
        },
      });
      hooks.onAgentEvent({
        type: "app_server_request",
        method: "item/permissions/requestApproval",
        params: {
          permissions: {
            fileSystem: {
              read: ["wiki/concepts/observability.md", "wiki/concepts/observability.md"],
            },
          },
        },
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        cwd: "C:\\Users\\leesh\\projects\\wiki",
        workdir: "wiki/ignored-workdir",
        workingDirectory: "wiki/ignored-working-directory",
        command: "Get-Content -Path wiki/maps/home.md",
        token_usage: {
          input: 10,
          output: 7,
          total: 17,
        },
        paths: ["C:\\Users\\leesh\\projects\\wiki\\index.md", ...manyPaths],
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        command: "Set-Content -LiteralPath wiki/concepts/write-target.md -Value test",
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        command: "Get-Content -Path wiki/concepts/read-write.md",
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        command: "Set-Content -LiteralPath wiki/concepts/read-write.md -Value test",
      });
      hooks.onAgentEvent({
        recipient_name: "functions.apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: tools/wiki-server/src/jobStore.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      });
      hooks.onAgentEvent({
        recipient_name: "functions.apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: wiki/concepts/large-patch.md",
          "@@",
          ...Array.from({ length: 120 }, (_value, index) => `+large patch line ${index} ${"x".repeat(80)}`),
          "*** End Patch",
        ].join("\n"),
      });
      hooks.onAgentEvent({
        recipient_name: "functions.apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: wiki/concepts/old-name.md",
          "*** Move to: wiki/concepts/new-name.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        command: "node scripts/check.js wiki/ambiguous/maybe.md",
      });
      hooks.onAgentEvent({
        tool: "shell_command",
        command:
          "C:\\Users\\leesh\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe -NoLogo -Command \"Get-Content -LiteralPath 'C:\\Users\\leesh\\projects\\Knowledge Manager\\docs\\SMOKE_EVIDENCE.md'; rg -n 'Duplicate/missing|locator\\s*:\\s*\\[(.*)\\]' wiki/projects\"",
      });

      return {
        done: Promise.resolve({ ok: true, result: { lastAgentMessage: "done" } }),
        cancel: () => undefined,
      };
    },
  });

  try {
    const job = store.enqueue("query", "test query");

    await eventually(() => store.getJob(job.id)?.status === "succeeded");
    await (store as unknown as { persistQueue: Promise<void> }).persistQueue;

    const metrics = metricsOf(store.getJob(job.id));
    assert.deepEqual(metrics.tokenUsageHighWater, {
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 17,
    });
    assert.equal("referencedFilePaths" in metrics, false);
    assert.deepEqual(Object.keys(metrics.fileObservability ?? {}).sort(), [
      "ambiguousFilePaths",
      "readFilePaths",
      "writeFilePaths",
    ]);
    assert.equal(
      metrics.fileObservability?.readFilePaths?.includes("wiki/concepts/observability.md"),
      true,
    );
    assert.equal(metrics.fileObservability?.readFilePaths?.includes("wiki/maps/home.md"), true);
    assert.equal(
      metrics.fileObservability?.writeFilePaths?.includes("wiki/concepts/write-target.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.readFilePaths?.includes("wiki/concepts/read-write.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.writeFilePaths?.includes("wiki/concepts/read-write.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.writeFilePaths?.includes("tools/wiki-server/src/jobStore.ts"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.writeFilePaths?.includes("wiki/concepts/large-patch.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.writeFilePaths?.includes("wiki/concepts/new-name.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.ambiguousFilePaths?.includes(
        "C:\\Users\\leesh\\projects\\wiki\\index.md",
      ),
      true,
    );
    assert.equal(
      metrics.fileObservability?.ambiguousFilePaths?.includes("wiki/ambiguous/maybe.md"),
      true,
    );
    assert.equal(
      metrics.fileObservability?.readFilePaths?.includes(
        "C:\\Users\\leesh\\projects\\Knowledge Manager\\docs\\SMOKE_EVIDENCE.md",
      ),
      true,
    );
    assert.equal(metrics.fileObservability?.readFilePaths?.includes("wiki/projects"), true);
    const observedFilePaths = allObservedFilePaths(metrics.fileObservability);
    assert.equal(observedFilePaths.includes("C:\\Users\\leesh\\projects\\wiki"), false);
    assert.equal(observedFilePaths.includes("wiki/ignored-workdir"), false);
    assert.equal(observedFilePaths.includes("wiki/ignored-working-directory"), false);
    assert.equal(
      observedFilePaths.includes("C:\\Users\\leesh\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"),
      false,
    );
    assert.equal(observedFilePaths.includes("C:\\Users\\leesh\\projects\\Knowledge"), false);
    assert.equal(observedFilePaths.includes("Manager\\docs\\SMOKE_EVIDENCE.md"), false);
    assert.equal(observedFilePaths.includes("Duplicate/missing"), false);
    assert.equal(observedFilePaths.includes("locator\\s"), false);
    assertInternallyUnique(metrics.fileObservability?.readFilePaths);
    assertInternallyUnique(metrics.fileObservability?.writeFilePaths);
    assertInternallyUnique(metrics.fileObservability?.ambiguousFilePaths);
    const classifiedFilePaths = new Set([
      ...(metrics.fileObservability?.readFilePaths ?? []),
      ...(metrics.fileObservability?.writeFilePaths ?? []),
    ]);
    for (const filePath of metrics.fileObservability?.ambiguousFilePaths ?? []) {
      assert.equal(classifiedFilePaths.has(filePath), false);
    }

    const persisted = JSON.parse(
      readFileSync(path.join(jobsDir, `${job.id}.meta.json`), "utf8"),
    ) as Job;
    const persistedMetrics = metricsOf(persisted);
    assert.deepEqual(persistedMetrics.tokenUsageHighWater, metrics.tokenUsageHighWater);
    assert.equal("referencedFilePaths" in persistedMetrics, false);
    assert.deepEqual(persistedMetrics.fileObservability, metrics.fileObservability);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("legacy referencedFilePaths migrate to ambiguous file observability", () => {
  const jobsDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-job-store-"));
  const jobId = "44444444-4444-4444-8444-444444444444";
  const onlyReferencedJobId = "55555555-5555-4555-8555-555555555555";
  const now = new Date().toISOString();
  const legacyMetrics = {
    queuedAheadCount: 0,
    referencedFilePaths: [
      "wiki/legacy/only-referenced.md",
      "wiki/legacy/read.md",
      "wiki/legacy/write.md",
    ],
    fileObservability: {
      readFilePaths: ["wiki/legacy/read.md"],
      writeFilePaths: ["wiki/legacy/write.md"],
    },
  } as StoredJob["metrics"] & { referencedFilePaths: string[] };
  const storedJob: StoredJob = {
    id: jobId,
    command: "query",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    contentLength: 12,
    contentPreview: "legacy job",
    lastEventAt: now,
    metrics: legacyMetrics,
  };
  writeStoredJob(jobsDir, storedJob);
  writeStoredEvents(jobsDir, jobId, [
    makeStoredEvent(jobId, 1, "status", storedJob, now),
    makeStoredEvent(jobId, 2, "done", storedJob, now),
  ]);
  writeStoredJob(jobsDir, {
    ...storedJob,
    id: onlyReferencedJobId,
    metrics: {
      queuedAheadCount: 0,
      referencedFilePaths: [
        "wiki/legacy/first.md",
        "wiki/legacy/second.md",
      ],
    } as StoredJob["metrics"] & { referencedFilePaths: string[] },
  });

  const store = new JobStore({
    jobsDir,
    heartbeatMs: 60_000,
    startRunner: () => {
      throw new Error("persisted terminal jobs should not restart");
    },
  });

  try {
    const metrics = metricsOf(store.getJob(jobId));
    assert.equal("referencedFilePaths" in metrics, false);
    assert.deepEqual(metrics.fileObservability?.readFilePaths, ["wiki/legacy/read.md"]);
    assert.deepEqual(metrics.fileObservability?.writeFilePaths, ["wiki/legacy/write.md"]);
    assert.deepEqual(metrics.fileObservability?.ambiguousFilePaths, [
      "wiki/legacy/only-referenced.md",
    ]);
    const persisted = JSON.parse(
      readFileSync(path.join(jobsDir, `${jobId}.meta.json`), "utf8"),
    ) as Job;
    const persistedMetrics = metricsOf(persisted);
    assert.equal("referencedFilePaths" in persistedMetrics, false);
    assert.deepEqual(persistedMetrics.fileObservability, metrics.fileObservability);

    const events = store.getEvents(jobId);
    assert.equal(events.length, 2);
    for (const event of events) {
      const eventMetrics = metricsOf(event.data as { metrics?: Job["metrics"] });
      assert.equal("referencedFilePaths" in eventMetrics, false);
      assert.deepEqual(eventMetrics.fileObservability, metrics.fileObservability);
    }

    const onlyReferencedMetrics = metricsOf(store.getJob(onlyReferencedJobId));
    assert.equal("referencedFilePaths" in onlyReferencedMetrics, false);
    assert.deepEqual(onlyReferencedMetrics.fileObservability, {
      ambiguousFilePaths: [
        "wiki/legacy/first.md",
        "wiki/legacy/second.md",
      ],
    });
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function metricsOf(job: { metrics?: Job["metrics"] } | undefined): NonNullable<Job["metrics"]> {
  assert.ok(job?.metrics);
  return job.metrics;
}

function allObservedFilePaths(observability: NonNullable<Job["metrics"]>["fileObservability"]) {
  return [
    ...(observability?.readFilePaths ?? []),
    ...(observability?.writeFilePaths ?? []),
    ...(observability?.ambiguousFilePaths ?? []),
  ];
}

function assertInternallyUnique(paths: string[] | undefined) {
  assert.equal(new Set(paths ?? []).size, paths?.length ?? 0);
}

function makeStoredJob(id: string, status: StoredJob["status"], now: string): StoredJob {
  return {
    id,
    command: "query",
    status,
    createdAt: now,
    updatedAt: now,
    startedAt: status === "running" ? now : undefined,
    contentLength: 10,
    contentPreview: "old query",
    lastEventAt: now,
    metrics: {
      queuedAheadCount: 0,
    },
  };
}

function makeStoredEvent(
  jobId: string,
  seq: number,
  event: JobEvent["event"],
  data: unknown,
  now: string,
): JobEvent {
  return {
    seq,
    at: now,
    jobId,
    event,
    data,
  };
}

function writeStoredJob(jobsDir: string, job: StoredJob) {
  writeFileSync(
    path.join(jobsDir, `${job.id}.meta.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    "utf8",
  );
}

function writeStoredEvents(jobsDir: string, jobId: string, events: JobEvent[]) {
  writeFileSync(
    legacyEventLogPath(jobsDir, jobId),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function writeCurrentStoredEvents(jobsDir: string, jobId: string, events: JobEvent[]) {
  const rawEventsDir = path.join(jobsDir, "raw-events");
  mkdirSync(rawEventsDir, { recursive: true });
  writeFileSync(
    eventLogPath(jobsDir, jobId),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function eventLogPath(jobsDir: string, jobId: string) {
  return path.join(jobsDir, "raw-events", `${jobId}.jsonl`);
}

function legacyEventLogPath(jobsDir: string, jobId: string) {
  return path.join(jobsDir, `${jobId}.jsonl`);
}
