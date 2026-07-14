import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formatJobInput } from "../jobs/jobCommand.js";
import type { Job, JobError, RunningProcess, RunnerResult } from "../jobs/jobTypes.js";

const STDERR_TAIL_LIMIT = 16_384;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const JOB_TURN_TIMEOUT_MS = 30 * 60_000;
const WARMUP_TURN_TIMEOUT_MS = 30_000;
const CANCEL_INTERRUPT_TIMEOUT_MS = 5_000;
const WARMUP_SENTINEL = "WIKI_SERVER_WARMUP_OK";

export const APP_SERVER_SANDBOX_DANGER_FULL_ACCESS = "danger-full-access";
export const APP_SERVER_SANDBOX_READ_ONLY = "read-only";

type JsonObject = Record<string, unknown>;

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type PendingRequest = {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WebSocketLike = {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean },
  ) => void;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

type ActiveTurn = {
  threadId: string;
  turnId?: string;
  lastAgentMessage?: string;
  resolve: (result: RunnerResult) => void;
  onAgentEvent: (event: unknown) => void;
};

type AppServerRunningProcess = RunningProcess & {
  canFallbackAfterFailure: () => boolean;
};

export type CodexAppServerRunnerOptions = {
  codexBin: string;
  wikiRoot: string;
  codexHome: string;
  port?: number;
  reservedPorts?: number[];
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  input?: string;
  onAgentEvent: (event: unknown) => void;
};

export class CodexAppServerManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ws: WebSocketLike | undefined;
  private wsUrl: string | undefined;
  private pending = new Map<number, PendingRequest>();
  private activeTurn: ActiveTurn | undefined;
  private nextRequestId = 1;
  private stderrTail = "";
  private ready = false;
  private starting: Promise<void> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly jobTurnTimeoutMs = JOB_TURN_TIMEOUT_MS,
    private readonly cancelInterruptTimeoutMs = CANCEL_INTERRUPT_TIMEOUT_MS,
  ) {}

  startJob(job: Job, options: CodexAppServerRunnerOptions): AppServerRunningProcess {
    let fallbackSafe = true;
    let cancelled = false;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let waitingBeforeThread = false;
    let cancelResetTimer: NodeJS.Timeout | undefined;

    const done = this.runExclusive(async (): Promise<RunnerResult> => {
      try {
        waitingBeforeThread = true;
        if (cancelled) return cancelledResult(this.stderrTail);
        await this.ensureReady(options);
        if (cancelled) return cancelledResult(this.stderrTail);

        const threadStartResult = await this.send(
          "thread/start",
          makeThreadStartParams(options, APP_SERVER_SANDBOX_DANGER_FULL_ACCESS, "wiki-server"),
        );
        if (cancelled) return cancelledResult(this.stderrTail);
        threadId = extractThreadId(threadStartResult);
        if (!threadId) {
          throw new Error(`thread/start did not return a thread id`);
        }
        waitingBeforeThread = false;
        const startedThreadId = threadId;

        options.onAgentEvent({
          type: "runner_event",
          runner: "app-server",
          event: "thread_started",
          threadId: startedThreadId,
        });

        const turnResult = new Promise<RunnerResult>((resolve) => {
          this.activeTurn = {
            threadId: startedThreadId,
            resolve,
            onAgentEvent: options.onAgentEvent,
          };
        });

        try {
          await this.send("turn/start", {
            threadId: startedThreadId,
            input: [
              {
                type: "text",
                text: options.input ?? formatJobInput(job.command, job.content),
                text_elements: [],
              },
            ],
          });
        } catch (error) {
          if (isAmbiguousTurnStartFailure(error)) {
            fallbackSafe = false;
          }
          throw error;
        }
        fallbackSafe = false;

        const result = await withTimeout(
          turnResult,
          this.jobTurnTimeoutMs,
          "Codex app-server turn timed out",
        );
        turnId = this.activeTurn?.turnId;
        this.activeTurn = undefined;
        return cancelled
          ? {
              ok: false,
              error: {
                message: "job cancelled",
                stderrTail: this.stderrTail,
                lastAgentMessage: result.ok ? result.result.lastAgentMessage : undefined,
              },
            }
          : result;
      } catch (error) {
        this.reset();
        const jobError = makeJobError("Codex app-server job failed", error, this.stderrTail);
        return { ok: false, error: jobError };
      } finally {
        const activeTurn = this.activeTurn;
        if (activeTurn && activeTurn.threadId === threadId) {
          turnId = activeTurn.turnId;
          this.activeTurn = undefined;
        }
        if (threadId) {
          this.unsubscribeThread(threadId);
        }
        if (cancelResetTimer) {
          clearTimeout(cancelResetTimer);
        }
      }
    });

    return {
      done,
      canFallbackAfterFailure: () => fallbackSafe && !cancelled,
      cancel: () => {
        cancelled = true;
        if (!threadId) {
          if (waitingBeforeThread) {
            this.reset();
          }
          return;
        }
        if (waitingBeforeThread) {
          this.reset();
          return;
        }

        const activeTurnId =
          turnId ?? (this.activeTurn?.threadId === threadId ? this.activeTurn.turnId : undefined);
        if (activeTurnId) {
          void this.send("turn/interrupt", {
            threadId,
            turnId: activeTurnId,
          }).catch(() => {
            this.reset();
          });
          cancelResetTimer = setTimeout(() => {
            this.reset();
          }, this.cancelInterruptTimeoutMs);
          return;
        }

        this.reset();
      },
    };
  }

  warmUp(options: Omit<CodexAppServerRunnerOptions, "onAgentEvent">): Promise<RunnerResult> {
    return this.runExclusive(async () => {
      let threadId: string | undefined;
      try {
        await this.ensureReady({
          ...options,
          onAgentEvent: () => {
            // Warmup is operational noise; keep it out of job event logs.
          },
        });

        const threadStartResult = await this.send(
          "thread/start",
          makeThreadStartParams(options, APP_SERVER_SANDBOX_READ_ONLY, "wiki-server-warmup"),
        );
        threadId = extractThreadId(threadStartResult);
        if (!threadId) {
          throw new Error(`thread/start did not return a thread id`);
        }
        const startedThreadId = threadId;

        const turnResult = new Promise<RunnerResult>((resolve) => {
          this.activeTurn = {
            threadId: startedThreadId,
            resolve,
            onAgentEvent: () => {
              // Warmup events are intentionally not persisted as user job events.
            },
          };
        });

        await this.send("turn/start", {
          threadId: startedThreadId,
          input: [
            {
              type: "text",
            text: "Reply with exactly: WIKI_SERVER_WARMUP_OK",
              text_elements: [],
            },
          ],
        });

        const result = await withTimeout(
          turnResult,
          WARMUP_TURN_TIMEOUT_MS,
          "Codex app-server warmup timed out",
        );
        this.activeTurn = undefined;
        if (result.ok && !result.result.lastAgentMessage?.includes(WARMUP_SENTINEL)) {
          return {
            ok: false,
            error: {
              message: `Codex app-server warmup returned unexpected response: ${result.result.lastAgentMessage ?? ""}`,
              stderrTail: this.stderrTail,
              lastAgentMessage: result.result.lastAgentMessage,
            },
          };
        }
        return result;
      } catch (error) {
        this.reset();
        return {
          ok: false,
          error: makeJobError("Codex app-server warmup failed", error, this.stderrTail),
        };
      } finally {
        if (threadId) {
          if (this.activeTurn?.threadId === threadId) {
            this.activeTurn = undefined;
          }
          this.unsubscribeThread(threadId);
        }
      }
    });
  }

  status() {
    return {
      ready: this.ready,
      wsUrl: this.wsUrl,
      pid: this.child?.pid,
    };
  }

  stop() {
    this.reset();
  }

  private async ensureReady(options: CodexAppServerRunnerOptions) {
    if (this.ready && this.ws) return;
    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = this.start(options).finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async start(options: CodexAppServerRunnerOptions) {
    bootstrapCodexHome(options.codexHome);
    const port = options.port ?? (await findOpenPort(new Set(options.reservedPorts ?? [])));
    const wsUrl = `ws://127.0.0.1:${port}`;
    this.wsUrl = wsUrl;
    this.stderrTail = "";

    const child = spawn(options.codexBin, ["app-server", "--listen", wsUrl], {
      cwd: options.wikiRoot,
      env: {
        ...process.env,
        CODEX_HOME: options.codexHome,
      },
      shell: process.platform === "win32" && !options.codexBin.toLowerCase().endsWith(".exe"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.appendStderr(chunk.toString("utf8"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.appendStderr(`[app-server stdout] ${chunk.toString("utf8")}`);
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        if (this.child !== child) return;
        this.appendStderr(`Codex app-server spawn error: ${error.message}\n`);
        this.ready = false;
        this.child = undefined;
        reject(error);
      });
    });
    const exitedBeforeReady = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        if (this.child === child && !this.ready) {
          reject(
            new Error(
              `Codex app-server exited before listening: code=${code ?? "null"} signal=${signal ?? "null"}`,
            ),
          );
        }
      });
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.rejectPending(new Error(`Codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
      this.ready = false;
      this.ws = undefined;
      this.child = undefined;
      this.failActiveTurn({
        message: "Codex app-server exited before turn completed",
        exitCode: code,
        signal,
      });
    });

    const ws = await Promise.race([
      connectWebSocket(wsUrl, START_TIMEOUT_MS),
      spawnFailed,
      exitedBeforeReady,
    ]);
    this.ws = ws;
    this.ready = true;

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      this.handleConnectionLoss(ws, "Codex app-server websocket closed");
    });
    ws.addEventListener("error", () => {
      this.handleConnectionLoss(ws, "Codex app-server websocket error");
    });

    await this.send("initialize", {
      clientInfo: {
        name: "wiki-server",
        title: "Wiki Server",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (!this.ws || !this.ready) {
      return Promise.reject(new Error("Codex app-server websocket is not ready"));
    }

    const id = this.nextRequestId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
    });
  }

  private notify(method: string, params: unknown) {
    if (!this.ws || !this.ready) return;
    this.ws.send(JSON.stringify({ method, params }));
  }

  private sendBestEffortRequest(method: string, params: unknown) {
    if (!this.ws || !this.ready) return;
    try {
      this.ws.send(JSON.stringify({ id: this.nextRequestId++, method, params }));
    } catch {
      // Best-effort cleanup requests should not change the completed job result.
    }
  }

  private unsubscribeThread(threadId: string) {
    this.sendBestEffortRequest("thread/unsubscribe", { threadId });
  }

  private respond(id: number, result: unknown) {
    if (!this.ws || !this.ready) return;
    this.ws.send(JSON.stringify({ id, result }));
  }

  private respondError(id: number, code: number, message: string) {
    if (!this.ws || !this.ready) return;
    this.ws.send(JSON.stringify({ id, error: { code, message } }));
  }

  private handleMessage(data: unknown) {
    let message: JsonObject;
    try {
      message = JSON.parse(String(data)) as JsonObject;
    } catch {
      this.appendStderr(`[app-server non-json message] ${String(data)}\n`);
      return;
    }

    if (typeof message.id === "number" && typeof message.method === "string") {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }

    if (typeof message.id === "number") {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleServerRequest(id: number, method: string, params: unknown) {
    const activeTurn = this.activeTurn;
    const belongsToActiveTurn = activeTurn ? notificationMatchesActiveTurn(params, activeTurn) : false;

    if (isTurnScopedServerRequest(method) && !belongsToActiveTurn) {
      this.respondError(id, -32000, `Request does not belong to the active wiki-server turn: ${method}`);
      return;
    }

    activeTurn?.onAgentEvent({
      type: "app_server_request",
      method,
      params,
    });

    switch (method) {
      case "item/commandExecution/requestApproval":
        this.respond(id, { decision: "accept" });
        return;
      case "item/fileChange/requestApproval":
        this.respond(id, { decision: "accept" });
        return;
      case "item/tool/requestUserInput":
        this.respondError(id, -32000, "Interactive user input is not supported by wiki-server");
        return;
      case "mcpServer/elicitation/request":
        this.respond(id, { action: "cancel", content: null, _meta: null });
        return;
      case "item/permissions/requestApproval":
        this.respond(id, {
          permissions: extractRequestedPermissions(params),
          scope: "turn",
        });
        return;
      default:
        this.respondError(id, -32601, `Unsupported app-server request: ${method}`);
    }
  }

  private handleResponse(message: JsonObject) {
    const pending = this.pending.get(message.id as number);
    if (!pending) return;

    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${formatJsonRpcError(message.error)}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown) {
    const activeTurn = this.activeTurn;
    const belongsToActiveTurn = activeTurn ? notificationMatchesActiveTurn(params, activeTurn) : false;
    if (belongsToActiveTurn) {
      activeTurn?.onAgentEvent({
        type: "app_server_notification",
        method,
        params,
      });
    }

    if (!activeTurn || !belongsToActiveTurn) return;

    if (method === "turn/started") {
      activeTurn.turnId = extractTurnId(params);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = extractAgentDelta(params);
      if (delta) {
        activeTurn.lastAgentMessage = `${activeTurn.lastAgentMessage ?? ""}${delta}`;
      }
      return;
    }

    if (method === "item/completed") {
      const message = extractCompletedAgentMessage(params);
      if (message) {
        activeTurn.lastAgentMessage = message;
      }
      return;
    }

    if (method === "turn/completed") {
      const completed = extractTurnCompletion(params);
      if (completed.status !== "completed") {
        activeTurn.resolve({
          ok: false,
          error: {
            message: completed.errorMessage ?? `Codex app-server turn ${completed.status}`,
            stderrTail: this.stderrTail,
            lastAgentMessage: activeTurn.lastAgentMessage,
          },
        });
      } else {
        activeTurn.resolve({
          ok: true,
          result: {
            lastAgentMessage: activeTurn.lastAgentMessage,
            stderrTail: this.stderrTail,
          },
        });
      }
      this.activeTurn = undefined;
      return;
    }

    if (method === "thread/error" || method === "turn/error") {
      activeTurn.resolve({
        ok: false,
        error: {
          message: `${method}: ${JSON.stringify(params)}`,
          stderrTail: this.stderrTail,
          lastAgentMessage: activeTurn.lastAgentMessage,
        },
      });
      this.activeTurn = undefined;
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleConnectionLoss(ws: WebSocketLike, message: string) {
    if (this.ws !== ws) return;
    this.ready = false;
    this.ws = undefined;
    this.rejectPending(new Error(message));
    this.failActiveTurn({ message });
    if (this.child && !this.child.killed) {
      terminateProcessTree(this.child);
    }
    this.child = undefined;
  }

  private failActiveTurn(error: Pick<JobError, "message" | "exitCode" | "signal">) {
    if (!this.activeTurn) return;
    this.activeTurn.resolve({
      ok: false,
      error: {
        ...error,
        stderrTail: this.stderrTail,
        lastAgentMessage: this.activeTurn.lastAgentMessage,
      },
    });
    this.activeTurn = undefined;
  }

  private appendStderr(chunk: string) {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  }

  private reset() {
    this.ready = false;
    this.wsUrl = undefined;
    this.rejectPending(new Error("Codex app-server reset"));
    if (this.activeTurn) {
      this.activeTurn.resolve({
        ok: false,
        error: {
          message: "Codex app-server reset before turn completed",
          stderrTail: this.stderrTail,
          lastAgentMessage: this.activeTurn.lastAgentMessage,
        },
      });
      this.activeTurn = undefined;
    }

    try {
      this.ws?.close();
    } catch {
      // best effort
    }
    this.ws = undefined;

    if (this.child && !this.child.killed) {
      terminateProcessTree(this.child);
    }
    this.child = undefined;
  }
}

function createWebSocket(url: string): WebSocketLike {
  const WebSocketCtor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("global WebSocket is unavailable; Node.js 22+ is required for app-server mode");
  }

  return new WebSocketCtor(url);
}

async function connectWebSocket(url: string, timeoutMs: number): Promise<WebSocketLike> {
  if (!(globalThis as { WebSocket?: WebSocketConstructor }).WebSocket) {
    throw new Error("global WebSocket is unavailable; Node.js 22+ is required for app-server mode");
  }

  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await new Promise<WebSocketLike>((resolve, reject) => {
        const ws = createWebSocket(url);
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            // best effort
          }
          reject(new Error("websocket connect timeout"));
        }, 1_000);

        ws.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve(ws);
          },
          { once: true },
        );
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("websocket connect error"));
          },
          { once: true },
        );
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(250);
    }
  }

  throw lastError ?? new Error(`timed out connecting to ${url}`);
}

async function findOpenPort(reservedPorts = new Set<number>()): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await allocateOpenPort();
    if (!reservedPorts.has(port)) return port;
  }

  throw new Error("failed to allocate a local app-server port outside reserved ports");
}

async function allocateOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate a local app-server port"));
        }
      });
    });
    server.on("error", reject);
  });
}

function bootstrapCodexHome(codexHome: string) {
  mkdirSync(codexHome, { recursive: true });
  const defaultCodexHome = path.join(os.homedir(), ".codex");
  for (const fileName of ["auth.json", "config.toml", "AGENTS.md"]) {
    const source = path.join(defaultCodexHome, fileName);
    const target = path.join(codexHome, fileName);
    if (shouldSyncCodexHomeFile(source, target)) {
      copyFileSync(source, target);
    }
  }
}

function shouldSyncCodexHomeFile(source: string, target: string) {
  if (!existsSync(source)) return false;
  if (!existsSync(target)) return true;

  try {
    return statSync(source).mtimeMs > statSync(target).mtimeMs;
  } catch {
    return false;
  }
}

function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as JsonObject;
  if (typeof object.threadId === "string") return object.threadId;
  if (typeof object.id === "string") return object.id;

  const thread = object.thread;
  if (thread && typeof thread === "object") {
    const threadObject = thread as JsonObject;
    if (typeof threadObject.id === "string") return threadObject.id;
  }

  return undefined;
}

function extractTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as JsonObject;
  if (typeof object.turnId === "string") return object.turnId;

  const turn = object.turn;
  if (turn && typeof turn === "object") {
    const turnObject = turn as JsonObject;
    if (typeof turnObject.id === "string") return turnObject.id;
  }

  return undefined;
}

function extractAgentDelta(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as JsonObject;
  if (typeof object.delta === "string") return object.delta;
  if (typeof object.text === "string") return object.text;
  return undefined;
}

function extractCompletedAgentMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as JsonObject;
  const item = object.item;
  if (item && typeof item === "object") {
    const itemObject = item as JsonObject;
    if (
      (itemObject.type === "agent_message" || itemObject.type === "agentMessage") &&
      typeof itemObject.text === "string"
    ) {
      return itemObject.text;
    }
  }

  return undefined;
}

function notificationMatchesActiveTurn(params: unknown, activeTurn: ActiveTurn) {
  if (!params || typeof params !== "object") return true;
  const object = params as JsonObject;
  const threadId = typeof object.threadId === "string" ? object.threadId : undefined;
  if (threadId && threadId !== activeTurn.threadId) return false;

  const turnId = extractTurnId(params);
  if (!turnId || !activeTurn.turnId) return true;
  return turnId === activeTurn.turnId;
}

function isTurnScopedServerRequest(method: string) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method === "item/permissions/requestApproval"
  );
}

function extractTurnCompletion(value: unknown): {
  status: "completed" | "failed" | "interrupted" | "unknown";
  errorMessage?: string;
} {
  if (!value || typeof value !== "object") return { status: "unknown" };
  const object = value as JsonObject;
  const turn = object.turn;
  if (!turn || typeof turn !== "object") return { status: "unknown" };

  const turnObject = turn as JsonObject;
  const status =
    turnObject.status === "completed" ||
    turnObject.status === "failed" ||
    turnObject.status === "interrupted"
      ? turnObject.status
      : "unknown";
  const error = turnObject.error;
  if (error && typeof error === "object") {
    const errorObject = error as JsonObject;
    if (typeof errorObject.message === "string") {
      return { status, errorMessage: errorObject.message };
    }
  }

  return { status };
}

function extractRequestedPermissions(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const permissions = (value as JsonObject).permissions;
  if (!permissions || typeof permissions !== "object") return {};
  const permissionsObject = permissions as JsonObject;
  return {
    network: permissionsObject.network ?? undefined,
    fileSystem: permissionsObject.fileSystem ?? undefined,
  };
}

function makeThreadStartParams(
  options: Omit<CodexAppServerRunnerOptions, "onAgentEvent">,
  sandbox: string,
  serviceName: string,
): JsonObject {
  const params: JsonObject = {
    cwd: options.wikiRoot,
    approvalPolicy: "never",
    sandbox,
    serviceName,
    ephemeral: true,
    experimentalRawEvents: false,
  };

  if (options.model) {
    params.model = options.model;
  }
  if (options.serviceTier) {
    params.serviceTier = options.serviceTier;
  }
  if (options.reasoningEffort) {
    params.config = {
      model_reasoning_effort: options.reasoningEffort,
    };
  }

  return params;
}

function formatJsonRpcError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const rpcError = error as JsonRpcError;
  return rpcError.message ?? JSON.stringify(error);
}

function makeJobError(prefix: string, error: unknown, stderrTail: string): JobError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: `${prefix}: ${message}`,
    stderrTail,
  };
}

function isAmbiguousTurnStartFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (/request timed out after \d+ms/.test(error.message)) return true;
  return /Codex app-server (websocket|exited|reset)/.test(error.message);
}

function cancelledResult(stderrTail: string): RunnerResult {
  return {
    ok: false,
    error: {
      message: "job cancelled",
      stderrTail,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.pid && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  child.kill();
}
