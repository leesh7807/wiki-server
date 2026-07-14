import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerManager } from "./codexAppServerRunner.js";
import type { Job, RunnerResult } from "../jobs/jobTypes.js";

test("spawn error resolves the app-server job as a pre-turn failure", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "wiki-server-app-runner-test-"));
  const manager = new CodexAppServerManager();
  try {
    const running = manager.startJob(makeJob("query"), {
      codexBin: path.join(codexHome, "missing-codex.exe"),
      wikiRoot: process.cwd(),
      codexHome,
      onAgentEvent: () => undefined,
    });

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /app-server job failed/i);
    }
    assert.equal(running.canFallbackAfterFailure(), true);
  } finally {
    manager.stop();
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("early app-server process exit resolves as a pre-turn failure", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "wiki-server-app-runner-test-"));
  const manager = new CodexAppServerManager();
  try {
    const running = manager.startJob(makeJob("query"), {
      codexBin: process.execPath,
      wikiRoot: process.cwd(),
      codexHome,
      onAgentEvent: () => undefined,
    });

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /app-server job failed/i);
    }
    assert.equal(running.canFallbackAfterFailure(), true);
  } finally {
    manager.stop();
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("websocket connection loss resolves the active turn", async () => {
  const manager = new CodexAppServerManager();
  try {
    let resolveResult: RunnerResult | undefined;
    const testManager = manager as unknown as {
      activeTurn: {
        threadId: string;
        lastAgentMessage?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      ws: { send: (data: string) => void; close: () => void };
      handleConnectionLoss: (ws: { send: (data: string) => void; close: () => void }, message: string) => void;
    };
    testManager.ws = {
      send: () => undefined,
      close: () => undefined,
    };

    testManager.activeTurn = {
      threadId: "thread-1",
      lastAgentMessage: "partial",
      resolve: (result) => {
        resolveResult = result;
      },
      onAgentEvent: () => undefined,
    };

    testManager.handleConnectionLoss(testManager.ws, "lost test connection");

    assert.deepEqual(resolveResult, {
      ok: false,
      error: {
        message: "lost test connection",
        stderrTail: "",
        lastAgentMessage: "partial",
      },
    });
  } finally {
    manager.stop();
  }
});

test("stale websocket connection loss does not affect the current app-server", async () => {
  const manager = new CodexAppServerManager();
  try {
    let resolveResult: RunnerResult | undefined;
    const staleWs = {
      send: () => undefined,
      close: () => undefined,
    };
    const currentWs = {
      send: () => undefined,
      close: () => undefined,
    };
    const testManager = manager as unknown as {
      ready: boolean;
      ws: typeof currentWs;
      activeTurn: {
        threadId: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleConnectionLoss: (ws: typeof currentWs, message: string) => void;
    };
    testManager.ready = true;
    testManager.ws = currentWs;
    testManager.activeTurn = {
      threadId: "thread-1",
      resolve: (result) => {
        resolveResult = result;
      },
      onAgentEvent: () => undefined,
    };

    testManager.handleConnectionLoss(staleWs, "old websocket closed");

    assert.equal(testManager.ready, true);
    assert.equal(testManager.ws, currentWs);
    assert.equal(resolveResult, undefined);
  } finally {
    manager.stop();
  }
});

test("turn/completed failed status resolves the job as failed", () => {
  const manager = new CodexAppServerManager();
  try {
    let resolveResult: RunnerResult | undefined;
    const testManager = manager as unknown as {
      activeTurn: {
        threadId: string;
        lastAgentMessage?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleNotification: (method: string, params: unknown) => void;
    };

    testManager.activeTurn = {
      threadId: "thread-1",
      lastAgentMessage: "partial",
      resolve: (result) => {
        resolveResult = result;
      },
      onAgentEvent: () => undefined,
    };

    testManager.handleNotification("turn/completed", {
      turn: {
        status: "failed",
        error: { message: "tool failed" },
      },
    });

    assert.deepEqual(resolveResult, {
      ok: false,
      error: {
        message: "tool failed",
        stderrTail: "",
        lastAgentMessage: "partial",
      },
    });
  } finally {
    manager.stop();
  }
});

test("notifications from another thread do not resolve the active turn", () => {
  const manager = new CodexAppServerManager();
  try {
    let resolveResult: RunnerResult | undefined;
    const testManager = manager as unknown as {
      activeTurn: {
        threadId: string;
        turnId?: string;
        lastAgentMessage?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleNotification: (method: string, params: unknown) => void;
    };

    testManager.activeTurn = {
      threadId: "current-thread",
      turnId: "current-turn",
      resolve: (result) => {
        resolveResult = result;
      },
      onAgentEvent: () => undefined,
    };

    testManager.handleNotification("item/agentMessage/delta", {
      threadId: "old-thread",
      turnId: "old-turn",
      delta: "wrong",
    });
    testManager.handleNotification("turn/completed", {
      threadId: "old-thread",
      turn: {
        id: "old-turn",
        status: "completed",
        error: null,
      },
    });

    assert.equal(resolveResult, undefined);
    assert.equal(testManager.activeTurn.lastAgentMessage, undefined);
  } finally {
    manager.stop();
  }
});

test("turn/completed unknown status resolves the job as failed", () => {
  const manager = new CodexAppServerManager();
  try {
    let resolveResult: RunnerResult | undefined;
    const testManager = manager as unknown as {
      activeTurn: {
        threadId: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleNotification: (method: string, params: unknown) => void;
    };

    testManager.activeTurn = {
      threadId: "thread-1",
      resolve: (result) => {
        resolveResult = result;
      },
      onAgentEvent: () => undefined,
    };

    testManager.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        status: "inProgress",
        error: null,
      },
    });

    assert.deepEqual(resolveResult, {
      ok: false,
      error: {
        message: "Codex app-server turn unknown",
        stderrTail: "",
        lastAgentMessage: undefined,
      },
    });
  } finally {
    manager.stop();
  }
});

test("completed app-server jobs unsubscribe the ephemeral thread", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleNotification: (method: string, params: unknown) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));
    testManager.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        status: "completed",
        error: null,
      },
    });

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, true);
    assert.equal(
      sent.some((data) => {
        const message = JSON.parse(data) as { method?: string; params?: { threadId?: string } };
        return message.method === "thread/unsubscribe" && message.params?.threadId === "thread-1";
      }),
      true,
    );
  } finally {
    manager.stop();
  }
});

test("thread/start includes configured model and reasoning effort", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleNotification: (method: string, params: unknown) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: "priority",
      input: "/query prepared input\n\n<retrieval />",
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as {
      id: number;
      method?: string;
      params?: {
        model?: string;
        serviceTier?: string;
        config?: { model_reasoning_effort?: string };
      };
    };

    assert.equal(threadStartRequest.method, "thread/start");
    assert.equal(threadStartRequest.params?.model, "gpt-5.5");
    assert.equal(threadStartRequest.params?.serviceTier, "priority");
    assert.deepEqual(threadStartRequest.params?.config, {
      model_reasoning_effort: "high",
    });

    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));
    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as {
      id: number;
      params?: { input?: Array<{ text?: string }> };
    };
    assert.equal(
      turnStartRequest.params?.input?.[0]?.text,
      "/query prepared input\n\n<retrieval />",
    );
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));
    testManager.handleNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        status: "completed",
        error: null,
      },
    });

    const result = await withTimeout(running.done, 5_000);
    assert.equal(result.ok, true);
  } finally {
    manager.stop();
  }
});

test("warmup fails when the sentinel response does not match", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleNotification: (method: string, params: unknown) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const warmup = manager.warmUp({
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "warmup-thread" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));
    testManager.handleNotification("item/completed", {
      threadId: "warmup-thread",
      item: {
        type: "agent_message",
        text: "not the sentinel",
      },
    });
    testManager.handleNotification("turn/completed", {
      threadId: "warmup-thread",
      turn: {
        status: "completed",
        error: null,
      },
    });

    const result = await withTimeout(warmup, 5_000);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /unexpected response/);
      assert.equal(result.error.lastAgentMessage, "not the sentinel");
    }
  } finally {
    manager.stop();
  }
});

test("warmup accepts responses that include the sentinel with extra formatting", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleNotification: (method: string, params: unknown) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const warmup = manager.warmUp({
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "warmup-thread" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));
    testManager.handleNotification("item/completed", {
      threadId: "warmup-thread",
      item: {
        type: "agent_message",
        text: "`WIKI_SERVER_WARMUP_OK`",
      },
    });
    testManager.handleNotification("turn/completed", {
      threadId: "warmup-thread",
      turn: {
        status: "completed",
        error: null,
      },
    });

    const result = await withTimeout(warmup, 5_000);

    assert.equal(result.ok, true);
  } finally {
    manager.stop();
  }
});

test("server-initiated approval requests are accepted for the current turn", () => {
  const manager = new CodexAppServerManager();
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void };
      activeTurn: {
        threadId: string;
        turnId?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.activeTurn = {
      threadId: "thread-1",
      turnId: "turn-1",
      resolve: () => undefined,
      onAgentEvent: () => undefined,
    };
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
    };

    testManager.handleMessage(JSON.stringify({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }));

    assert.deepEqual(JSON.parse(sent[0] ?? "{}"), {
      id: 7,
      result: { decision: "accept" },
    });
  } finally {
    manager.stop();
  }
});

test("server-initiated approval requests outside the active turn are rejected", () => {
  const manager = new CodexAppServerManager();
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void };
      activeTurn: {
        threadId: string;
        turnId?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.activeTurn = {
      threadId: "current-thread",
      turnId: "current-turn",
      resolve: () => undefined,
      onAgentEvent: () => undefined,
    };
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
    };

    testManager.handleMessage(JSON.stringify({
      id: 10,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "old-thread",
        turnId: "old-turn",
      },
    }));

    const response = JSON.parse(sent[0] ?? "{}") as {
      id?: number;
      error?: { code?: number; message?: string };
    };
    assert.equal(response.id, 10);
    assert.equal(response.error?.code, -32000);
    assert.match(response.error?.message ?? "", /does not belong/);
  } finally {
    manager.stop();
  }
});

test("server-initiated permission requests grant the requested profile for the current turn", () => {
  const manager = new CodexAppServerManager();
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void };
      activeTurn: {
        threadId: string;
        turnId?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.activeTurn = {
      threadId: "thread-1",
      turnId: "turn-1",
      resolve: () => undefined,
      onAgentEvent: () => undefined,
    };
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
    };

    testManager.handleMessage(JSON.stringify({
      id: 8,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: null,
            write: ["C:\\Users\\leesh\\projects\\wiki"],
          },
        },
      },
    }));

    assert.deepEqual(JSON.parse(sent[0] ?? "{}"), {
      id: 8,
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: null,
            write: ["C:\\Users\\leesh\\projects\\wiki"],
          },
        },
        scope: "turn",
      },
    });
  } finally {
    manager.stop();
  }
});

test("server-initiated user input requests fail explicitly", () => {
  const manager = new CodexAppServerManager();
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void };
      activeTurn: {
        threadId: string;
        turnId?: string;
        resolve: (result: RunnerResult) => void;
        onAgentEvent: (event: unknown) => void;
      };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.activeTurn = {
      threadId: "thread-1",
      turnId: "turn-1",
      resolve: () => undefined,
      onAgentEvent: () => undefined,
    };
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
    };

    testManager.handleMessage(JSON.stringify({
      id: 9,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }));

    const response = JSON.parse(sent[0] ?? "{}") as {
      id?: number;
      error?: { code?: number; message?: string };
    };
    assert.equal(response.id, 9);
    assert.equal(response.error?.code, -32000);
    assert.match(response.error?.message ?? "", /not supported/);
  } finally {
    manager.stop();
  }
});

test("json-rpc requests time out instead of hanging forever", async () => {
  const manager = new CodexAppServerManager(20);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void };
      send: (method: string, params: unknown) => Promise<unknown>;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
    };

    await assert.rejects(
      testManager.send("thread/start", {}),
      /thread\/start: request timed out after 20ms/,
    );
    assert.equal(sent.length, 1);
  } finally {
    manager.stop();
  }
});

test("turn-start explicit json-rpc errors remain safe for exec fallback", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      error: { code: -32602, message: "invalid turn input" },
    }));

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    assert.equal(running.canFallbackAfterFailure(), true);
    if (!result.ok) {
      assert.match(result.error.message, /turn\/start: invalid turn input/);
    }
  } finally {
    manager.stop();
  }
});

test("turn-start connection loss after send is treated as post-acceptance ambiguity", async () => {
  const manager = new CodexAppServerManager(1_000);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleConnectionLoss: (ws: { send: (data: string) => void; close: () => void }, message: string) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    await eventually(() => sent.length >= 2);
    testManager.handleConnectionLoss(testManager.ws, "Codex app-server websocket closed");

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    assert.equal(running.canFallbackAfterFailure(), false);
    if (!result.ok) {
      assert.match(result.error.message, /websocket closed/);
    }
  } finally {
    manager.stop();
  }
});

test("active turn cancel resets the app-server when interrupt does not complete", async () => {
  const manager = new CodexAppServerManager(1_000, 1_000, 20);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
      handleNotification: (method: string, params: unknown) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));
    testManager.handleNotification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    });

    running.cancel();
    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    assert.equal(running.canFallbackAfterFailure(), false);
    assert.equal(
      sent.some((data) => {
        const message = JSON.parse(data) as {
          method?: string;
          params?: { threadId?: string; turnId?: string };
        };
        return (
          message.method === "turn/interrupt" &&
          message.params?.threadId === "thread-1" &&
          message.params.turnId === "turn-1"
        );
      }),
      true,
    );
    if (!result.ok) {
      assert.match(result.error.message, /job cancelled/);
    }
  } finally {
    manager.stop();
  }
});

test("turn-start request timeout is treated as post-acceptance ambiguity", async () => {
  const manager = new CodexAppServerManager(20);
  const sent: string[] = [];
  let closed = false;
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        closed = true;
      },
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    assert.equal(running.canFallbackAfterFailure(), false);
    assert.equal(closed, true);
    if (!result.ok) {
      assert.match(result.error.message, /turn\/start: request timed out/);
    }
  } finally {
    manager.stop();
  }
});

test("real app-server turns time out instead of hanging forever", async () => {
  const manager = new CodexAppServerManager(1_000, 20);
  const sent: string[] = [];
  try {
    const testManager = manager as unknown as {
      ready: boolean;
      ws: { send: (data: string) => void; close: () => void };
      handleMessage: (data: string) => void;
    };
    testManager.ready = true;
    testManager.ws = {
      send: (data) => {
        sent.push(data);
      },
      close: () => undefined,
    };

    const running = manager.startJob(makeJob("query"), {
      codexBin: "unused",
      wikiRoot: process.cwd(),
      codexHome: process.cwd(),
      onAgentEvent: () => undefined,
    });

    await eventually(() => sent.length >= 1);
    const threadStartRequest = JSON.parse(sent[0] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: threadStartRequest.id,
      result: { thread: { id: "thread-1" } },
    }));

    await eventually(() => sent.length >= 2);
    const turnStartRequest = JSON.parse(sent[1] ?? "{}") as { id: number };
    testManager.handleMessage(JSON.stringify({
      id: turnStartRequest.id,
      result: {},
    }));

    const result = await withTimeout(running.done, 5_000);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /turn timed out/);
    }
  } finally {
    manager.stop();
  }
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(predicate(), true);
}

function makeJob(command: Job["command"]): Job {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000002",
    command,
    content: "test",
    status: "running",
    createdAt: now,
    updatedAt: now,
    contentLength: 4,
    contentPreview: "test",
  };
}
