import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner, type AppServerManagerLike } from "./agentRunner.js";
import type { Job, RunnerResult, RunningProcess } from "../jobs/jobTypes.js";

const baseOptions = {
  mode: "app-server" as const,
  codexBin: "codex",
  codexVersion: "codex-cli 1.2.3",
  wikiRoot: process.cwd(),
  appServerCodexHome: process.cwd(),
  warmupEnabled: true,
};

test("falls back to exec when app-server fails before a turn starts", async () => {
  const events: unknown[] = [];
  const appServer = fakeAppServer({
    startJob: () => ({
      done: Promise.resolve({
        ok: false,
        error: { message: "pre-turn failure" },
      }),
      cancel: () => undefined,
      canFallbackAfterFailure: () => true,
    }),
  });

  let execStarted = false;
  const runner = new AgentRunner(baseOptions, {
    appServer,
    startExecJob: () => {
      execStarted = true;
      return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
    },
  });

  const result = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;

  assert.equal(execStarted, true);
  assert.deepEqual(result, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.equal(
    events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "runner_fallback",
    ),
    true,
  );
});

test("does not fall back after app-server has accepted a turn", async () => {
  const appServer = fakeAppServer({
    startJob: () => ({
      done: Promise.resolve({
        ok: false,
        error: { message: "post-turn failure" },
      }),
      cancel: () => undefined,
      canFallbackAfterFailure: () => false,
    }),
  });

  let execStarted = false;
  const runner = new AgentRunner(baseOptions, {
    appServer,
    startExecJob: () => {
      execStarted = true;
      return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
    },
  });

  const result = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;

  assert.equal(execStarted, false);
  assert.deepEqual(result, { ok: false, error: { message: "post-turn failure" } });
});

test("cancelled app-server job does not start exec fallback", async () => {
  let resolveApp: (result: RunnerResult) => void = () => undefined;
  let appCancelled = false;
  let execStarted = false;
  const appServer = fakeAppServer({
    startJob: () => ({
      done: new Promise<RunnerResult>((resolve) => {
        resolveApp = resolve;
      }),
      cancel: () => {
        appCancelled = true;
      },
      canFallbackAfterFailure: () => true,
    }),
  });

  const runner = new AgentRunner(baseOptions, {
    appServer,
    startExecJob: () => {
      execStarted = true;
      return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
    },
  });

  const process = runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  });
  process.cancel();
  resolveApp({ ok: false, error: { message: "cancelled app failure" } });
  const result = await process.done;

  assert.equal(appCancelled, true);
  assert.equal(execStarted, false);
  assert.deepEqual(result, { ok: false, error: { message: "cancelled app failure" } });
});

test("warmup records success and skips repeated warmup", async () => {
  let warmupCount = 0;
  const appServer = fakeAppServer({
    warmUp: async () => {
      warmupCount += 1;
      return { ok: true, result: { lastAgentMessage: "warm" } };
    },
  });
  const runner = new AgentRunner(baseOptions, { appServer });

  await runner.warmUp();
  await runner.warmUp();

  assert.equal(warmupCount, 1);
  assert.equal((runner.status().warmup as { status: string }).status, "succeeded");
});

test("exec mode skips app-server warmup", async () => {
  let warmupCount = 0;
  const appServer = fakeAppServer({
    warmUp: async () => {
      warmupCount += 1;
      return { ok: true, result: {} };
    },
  });
  const runner = new AgentRunner(
    {
      ...baseOptions,
      mode: "exec",
    },
    { appServer },
  );

  await runner.warmUp();

  assert.equal(warmupCount, 0);
  assert.equal((runner.status().warmup as { status: string }).status, "idle");
});

test("jobs stay on app-server path while startup warmup is still running", async () => {
  const events: unknown[] = [];
  let appStarted = false;
  let execStarted = false;
  const appServer = fakeAppServer({
    warmUp: async () => new Promise<RunnerResult>(() => undefined),
    startJob: () => {
      appStarted = true;
      return completedAppProcess({ ok: true, result: { lastAgentMessage: "app-ok" } });
    },
  });
  const runner = new AgentRunner(baseOptions, {
    appServer,
    startExecJob: () => {
      execStarted = true;
      return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
    },
  });

  void runner.warmUp();
  await Promise.resolve();
  assert.equal((runner.status().warmup as { status: string }).status, "running");
  const result = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;

  assert.equal(appStarted, true);
  assert.equal(execStarted, false);
  assert.deepEqual(result, { ok: true, result: { lastAgentMessage: "app-ok" } });
  assert.equal(
    events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "runner_fallback",
    ),
    false,
  );
});

test("failed warmup retries app-server in the background before restoring app jobs", async () => {
  const events: unknown[] = [];
  let appStartCount = 0;
  let execStartCount = 0;
  let warmupCount = 0;
  const appServer = fakeAppServer({
    warmUp: async () => {
      warmupCount += 1;
      return warmupCount === 1
        ? { ok: false, error: { message: "unsupported app-server" } }
        : { ok: true, result: { lastAgentMessage: "warm" } };
    },
    startJob: () => {
      appStartCount += 1;
      return completedAppProcess({ ok: true, result: { lastAgentMessage: "app-ok" } });
    },
  });
  const runner = new AgentRunner(
    {
      ...baseOptions,
      warmupFailureFallbackMs: 20,
    },
    {
      appServer,
      startExecJob: () => {
        execStartCount += 1;
        return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
      },
    },
  );

  const warmup = await runner.warmUp();
  const fallbackResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retryWindowResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;
  await eventually(() => (runner.status().warmup as { status: string }).status === "succeeded");
  const restoredResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;

  assert.deepEqual(warmup, { ok: false, error: { message: "unsupported app-server" } });
  assert.equal(warmupCount, 2);
  assert.equal(appStartCount, 1);
  assert.equal(execStartCount, 2);
  assert.deepEqual(fallbackResult, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(retryWindowResult, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(restoredResult, { ok: true, result: { lastAgentMessage: "app-ok" } });
  assert.equal((runner.status().warmup as { status: string }).status, "succeeded");
  assert.equal(
    events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "runner_fallback",
    ),
    true,
  );
});

test("upgrade-required warmup failures do not retry through exec", async () => {
  const events: unknown[] = [];
  let execStartCount = 0;
  const runner = new AgentRunner(baseOptions, {
    appServer: fakeAppServer({
      warmUp: async () => ({
        ok: false,
        error: {
          message: "Codex app-server warmup failed",
          stderrTail: "gpt-5.6-terra requires a newer version of Codex",
        },
      }),
    }),
    startExecJob: () => {
      execStartCount += 1;
      return completedProcess({ ok: true, result: {} });
    },
  });

  await runner.warmUp();
  const result = await runner.startJob(makeJob("query"), {
    onAgentEvent: (event) => events.push(event),
  }).done;
  const status = runner.status();

  assert.equal(execStartCount, 0);
  assert.deepEqual(result, {
    ok: false,
    error: { message: "Codex app-server warmup failed" },
  });
  assert.equal(status.codexVersion, "codex-cli 1.2.3");
  assert.equal(status.protocolReady, true);
  assert.equal(status.modelReady, false);
  assert.equal(
    (status.warmup as { failureKind?: string }).failureKind,
    "codex_upgrade_required",
  );
  assert.equal(
    events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "runner_fallback_suppressed",
    ),
    true,
  );
});

test("jobs use exec while background warmup retry is still running", async () => {
  let appStartCount = 0;
  let execStartCount = 0;
  let warmupCount = 0;
  let resolveRetryWarmup: (result: RunnerResult) => void = () => undefined;
  const appServer = fakeAppServer({
    warmUp: async () => {
      warmupCount += 1;
      if (warmupCount === 1) {
        return { ok: false, error: { message: "app-server unavailable" } };
      }
      return new Promise<RunnerResult>((resolve) => {
        resolveRetryWarmup = resolve;
      });
    },
    startJob: () => {
      appStartCount += 1;
      return completedAppProcess({ ok: true, result: { lastAgentMessage: "app-ok" } });
    },
  });
  const runner = new AgentRunner(
    {
      ...baseOptions,
      warmupFailureFallbackMs: 20,
    },
    {
      appServer,
      startExecJob: () => {
        execStartCount += 1;
        return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
      },
    },
  );

  await runner.warmUp();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retrySchedulingResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;
  assert.equal((runner.status().warmup as { status: string }).status, "running");
  const retryRunningResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;
  resolveRetryWarmup({ ok: true, result: { lastAgentMessage: "warm" } });
  await eventually(() => (runner.status().warmup as { status: string }).status === "succeeded");
  const restoredResult = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;

  assert.equal(warmupCount, 2);
  assert.equal(appStartCount, 1);
  assert.equal(execStartCount, 2);
  assert.deepEqual(retrySchedulingResult, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(retryRunningResult, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(restoredResult, { ok: true, result: { lastAgentMessage: "app-ok" } });
});

test("pre-turn app-server failures refresh temporary exec fallback", async () => {
  let appStartCount = 0;
  let execStartCount = 0;
  const appServer = fakeAppServer({
    startJob: () => {
      appStartCount += 1;
      return {
        done: Promise.resolve({ ok: false, error: { message: "app-server unavailable" } }),
        cancel: () => undefined,
        canFallbackAfterFailure: () => true,
      };
    },
  });
  const runner = new AgentRunner(
    {
      ...baseOptions,
      warmupFailureFallbackMs: 1_000,
    },
    {
      appServer,
      startExecJob: () => {
        execStartCount += 1;
        return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
      },
    },
  );

  const first = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;
  const second = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;

  assert.equal(appStartCount, 1);
  assert.equal(execStartCount, 2);
  assert.deepEqual(first, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(second, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.equal((runner.status().warmup as { status: string }).status, "failed");
});

test("upgrade-required pre-turn failures do not retry through exec", async () => {
  let execStartCount = 0;
  const failure = {
    ok: false as const,
    error: { message: "model requires newer Codex; please update Codex" },
  };
  const runner = new AgentRunner(baseOptions, {
    appServer: fakeAppServer({
      startJob: () => ({
        done: Promise.resolve(failure),
        cancel: () => undefined,
        canFallbackAfterFailure: () => true,
      }),
    }),
    startExecJob: () => {
      execStartCount += 1;
      return completedProcess({ ok: true, result: {} });
    },
  });

  const result = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;

  assert.equal(execStartCount, 0);
  assert.deepEqual(result, failure);
});

test("disabled startup warmup still allows background recovery after app-server failure", async () => {
  let warmupCount = 0;
  let appStartCount = 0;
  let execStartCount = 0;
  const appServer = fakeAppServer({
    warmUp: async () => {
      warmupCount += 1;
      return { ok: true, result: { lastAgentMessage: "warm" } };
    },
    startJob: () => {
      appStartCount += 1;
      return appStartCount === 1
        ? {
            done: Promise.resolve({ ok: false, error: { message: "app-server unavailable" } }),
            cancel: () => undefined,
            canFallbackAfterFailure: () => true,
          }
        : completedAppProcess({ ok: true, result: { lastAgentMessage: "app-ok" } });
    },
  });
  const runner = new AgentRunner(
    {
      ...baseOptions,
      warmupEnabled: false,
      warmupFailureFallbackMs: 20,
    },
    {
      appServer,
      startExecJob: () => {
        execStartCount += 1;
        return completedProcess({ ok: true, result: { lastAgentMessage: "exec-ok" } });
      },
    },
  );

  const first = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;
  await eventually(() => (runner.status().warmup as { status: string }).status === "succeeded");
  const third = await runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  }).done;

  assert.equal(warmupCount, 1);
  assert.equal(appStartCount, 2);
  assert.equal(execStartCount, 2);
  assert.deepEqual(first, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(second, { ok: true, result: { lastAgentMessage: "exec-ok" } });
  assert.deepEqual(third, { ok: true, result: { lastAgentMessage: "app-ok" } });
});

test("stop cancels an active exec runner", async () => {
  let execCancelled = false;
  const runner = new AgentRunner(
    {
      ...baseOptions,
      mode: "exec",
    },
    {
      startExecJob: () => ({
        done: new Promise<RunnerResult>(() => undefined),
        cancel: () => {
          execCancelled = true;
        },
      }),
    },
  );

  runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  });
  runner.stop();

  assert.equal(execCancelled, true);
});

test("stop cancels an active fallback exec runner", async () => {
  let fallbackCancelled = false;
  let resolveApp: (result: RunnerResult) => void = () => undefined;
  const appServer = fakeAppServer({
    startJob: () => ({
      done: new Promise<RunnerResult>((resolve) => {
        resolveApp = resolve;
      }),
      cancel: () => undefined,
      canFallbackAfterFailure: () => true,
    }),
  });
  const runner = new AgentRunner(baseOptions, {
    appServer,
    startExecJob: () => ({
      done: new Promise<RunnerResult>(() => undefined),
      cancel: () => {
        fallbackCancelled = true;
      },
    }),
  });

  const process = runner.startJob(makeJob("query"), {
    onAgentEvent: () => undefined,
  });
  resolveApp({ ok: false, error: { message: "pre-turn failure" } });
  await Promise.resolve();
  runner.stop();
  process.cancel();

  assert.equal(fallbackCancelled, true);
});

test("selects a model for each command on app-server and exec paths", async () => {
  const appModels: Array<string | undefined> = [];
  const execModels: Array<string | undefined> = [];
  const appEfforts: Array<string | undefined> = [];
  const execEfforts: Array<string | undefined> = [];
  const execCodexHomes: string[] = [];
  const appRunner = new AgentRunner(
    {
      ...baseOptions,
      appServerModels: {
        query: "query-model",
        ingest: "ingest-model",
        lint: "lint-model",
      },
      appServerReasoningEfforts: {
        query: "low",
        ingest: "medium",
        lint: "high",
      },
    },
    {
      appServer: fakeAppServer({
        startJob: (_job, options) => {
          appModels.push(options.model);
          appEfforts.push(options.reasoningEffort);
          return completedAppProcess({ ok: true, result: {} });
        },
      }),
    },
  );

  for (const command of ["query", "ingest", "lint"] as const) {
    await appRunner.startJob(makeJob(command), { onAgentEvent: () => undefined }).done;
  }

  const execRunner = new AgentRunner(
    {
      ...baseOptions,
      mode: "exec",
      appServerModels: {
        query: "query-model",
        ingest: "ingest-model",
        lint: "lint-model",
      },
      appServerReasoningEfforts: {
        query: "low",
        ingest: "medium",
        lint: "high",
      },
    },
    {
      startExecJob: (_job, options) => {
        execModels.push(options.model);
        execEfforts.push(options.reasoningEffort);
        execCodexHomes.push(options.codexHome);
        return completedProcess({ ok: true, result: {} });
      },
    },
  );

  for (const command of ["query", "ingest", "lint"] as const) {
    await execRunner.startJob(makeJob(command), { onAgentEvent: () => undefined }).done;
  }

  assert.deepEqual(appModels, ["query-model", "ingest-model", "lint-model"]);
  assert.deepEqual(execModels, ["query-model", "ingest-model", "lint-model"]);
  assert.deepEqual(appEfforts, ["low", "medium", "high"]);
  assert.deepEqual(execEfforts, ["low", "medium", "high"]);
  assert.deepEqual(execCodexHomes, [process.cwd(), process.cwd(), process.cwd()]);
});

test("reuses one prepared input for app-server and exec fallback", async () => {
  const inputs: Array<string | undefined> = [];
  const runner = new AgentRunner(baseOptions, {
    appServer: fakeAppServer({
      startJob: (_job, options) => {
        inputs.push(options.input);
        return {
          done: Promise.resolve({ ok: false, error: { message: "pre-turn failure" } }),
          cancel: () => undefined,
          canFallbackAfterFailure: () => true,
        };
      },
    }),
    startExecJob: (_job, options) => {
      inputs.push(options.input);
      return completedProcess({ ok: true, result: {} });
    },
  });

  const result = await runner.startJob(
    makeJob("query"),
    { onAgentEvent: () => undefined },
    "/query test\n\n<retrieval />",
  ).done;

  assert.equal(result.ok, true);
  assert.deepEqual(inputs, [
    "/query test\n\n<retrieval />",
    "/query test\n\n<retrieval />",
  ]);
});

function fakeAppServer(overrides: Partial<AppServerManagerLike>): AppServerManagerLike {
  return {
    startJob: () => completedAppProcess({ ok: true, result: { lastAgentMessage: "app-ok" } }),
    warmUp: async () => ({ ok: true, result: { lastAgentMessage: "warm" } }),
    status: () => ({ ready: true }),
    stop: () => undefined,
    ...overrides,
  };
}

function completedAppProcess(result: RunnerResult) {
  return {
    done: Promise.resolve(result),
    cancel: () => undefined,
    canFallbackAfterFailure: () => false,
  };
}

function completedProcess(result: RunnerResult): RunningProcess {
  return {
    done: Promise.resolve(result),
    cancel: () => undefined,
  };
}

function makeJob(command: Job["command"]): Job {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    command,
    content: "test",
    status: "running",
    createdAt: now,
    updatedAt: now,
    contentLength: 4,
    contentPreview: "test",
  };
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}
