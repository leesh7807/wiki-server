import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { AgentRunner, type AgentRunnerMode } from "./agentRunner.js";
import {
  resolveWikiCommandModels,
  resolveWikiCommandReasoningEfforts,
  resolveWikiServerPaths,
  findPackageRoot,
} from "./config.js";
import { renderClientHtml } from "./clientHtml.js";
import { parseCommandContent } from "./commandInput.js";
import { JobStore } from "./jobStore.js";
import { startHttpServer } from "./serverStartup.js";
import type { JobCommand, JobEvent, PublicJob } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = findPackageRoot(__dirname);
const paths = resolveWikiServerPaths({ packageRoot });

const wikiRoot = paths.wikiRoot;
const port = parseRequiredPort(process.env.PORT ?? "55173", "PORT");
const host = process.env.HOST ?? "127.0.0.1";
const codexBin = process.env.CODEX_BIN ?? defaultCodexBin();
const agentRunnerMode = parseAgentRunnerMode(process.env.WIKI_AGENT_RUNNER);
const appServerCodexHome = paths.appServerCodexHome;
const appServerPort = parseOptionalPort(process.env.WIKI_CODEX_APP_SERVER_PORT);
const appServerModels = resolveWikiCommandModels();
const appServerReasoningEfforts = resolveWikiCommandReasoningEfforts();
const appServerServiceTier = parseOptionalString(process.env.WIKI_CODEX_SERVICE_TIER);
const appServerWarmupEnabled = process.env.WIKI_APP_SERVER_WARMUP !== "0";
if (appServerPort !== undefined && appServerPort === port) {
  throw new Error("WIKI_CODEX_APP_SERVER_PORT must differ from the wiki HTTP PORT");
}
const parsedHeartbeatMs = Number.parseInt(process.env.HEARTBEAT_MS ?? "60000", 10);
const heartbeatMs = Number.isFinite(parsedHeartbeatMs) && parsedHeartbeatMs > 0
  ? parsedHeartbeatMs
  : 60000;
const jobsDir = paths.jobsDir;
const httpLoggerEnabled = process.env.WIKI_SERVER_HTTP_LOG === "1";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const app = Fastify({
  logger: httpLoggerEnabled,
});

const agentRunner = new AgentRunner({
  mode: agentRunnerMode,
  codexBin,
  wikiRoot,
  appServerCodexHome,
  appServerPort,
  appServerReservedPorts: [port],
  appServerModels,
  appServerReasoningEfforts,
  appServerServiceTier,
  warmupEnabled: appServerWarmupEnabled,
});

const store = new JobStore({
  jobsDir,
  heartbeatMs,
  startRunner: (job, hooks) => agentRunner.startJob(job, hooks),
});

app.addHook("onClose", () => {
  agentRunner.stop();
});

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(renderClientHtml());
});

app.get("/client", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(renderClientHtml());
});

app.get("/health", async () => ({
  ok: true,
  wikiRoot,
  wikiRootSource: paths.wikiRootSource,
  dataDir: paths.dataDir,
  heartbeatMs,
  httpLoggerEnabled,
  agentRunner: agentRunner.status(),
}));

app.get("/metrics/jobs", async () => store.getMetricsSummary());

app.post("/ingest", async (request, reply) => {
  return enqueueCommand("ingest", request.body, reply);
});

app.post("/query", async (request, reply) => {
  return enqueueCommand("query", request.body, reply);
});

app.post("/lint", async (request, reply) => {
  return enqueueCommand("lint", request.body, reply);
});

app.get("/jobs/:id", async (request, reply) => {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "invalid job id" });
  }

  const job = store.getJob(params.data.id);
  if (!job) {
    return reply.code(404).send({ error: "job not found" });
  }

  return job;
});

app.get("/jobs/:id/events", async (request, reply) => {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "invalid job id" });
  }

  const job = store.getJob(params.data.id);
  if (!job) {
    return reply.code(404).send({ error: "job not found" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.hijack();

  const send = (event: JobEvent["event"], data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("status", job);
  let sentDone = false;
  let replayComplete = false;
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const sentSeqs = new Set<number>();
  const liveBuffer: JobEvent[] = [];
  const sendJobEvent = (event: JobEvent) => {
    if (sentSeqs.has(event.seq)) return;
    sentSeqs.add(event.seq);
    send(event.event, event.data);
    if (event.event === "done") {
      sentDone = true;
    }
  };
  const closeStream = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    reply.raw.end();
  };
  unsubscribe = store.onJobEvent(params.data.id, (event) => {
    if (closed) return;
    if (!replayComplete) {
      liveBuffer.push(event);
      return;
    }
    sendJobEvent(event);
    if (sentDone) {
      closeStream();
    }
  });

  for (const event of store.getEvents(params.data.id)) {
    sendJobEvent(event);
  }
  replayComplete = true;
  for (const event of liveBuffer) {
    sendJobEvent(event);
  }
  liveBuffer.length = 0;

  if (isTerminalJob(job) || sentDone) {
    closeStream();
    return;
  }

  const latestJob = store.getJob(params.data.id);
  if (latestJob && isTerminalJob(latestJob)) {
    if (!sentDone) {
      send("done", latestJob);
      sentDone = true;
    }
    closeStream();
    return;
  }

  request.raw.on("close", () => {
    closeStream();
  });
});

app.post("/jobs/:id/cancel", async (request, reply) => {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "invalid job id" });
  }

  const job = store.cancel(params.data.id);
  if (!job) {
    return reply.code(404).send({ error: "job not found" });
  }

  return job;
});

function enqueueCommand(command: JobCommand, body: unknown, reply: FastifyReply) {
  const parsed = parseCommandContent(command, body);
  if (!parsed.ok) {
    return reply.code(400).send({ error: parsed.message });
  }

  const job = store.enqueue(command, parsed.content);
  return reply.code(202).send({
    jobId: job.id,
    status: job.status,
    eventsUrl: `/jobs/${job.id}/events`,
  });
}

function isTerminalJob(job: PublicJob) {
  return (
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "interrupted"
  );
}

void startServer().catch((error) => {
  app.log.error(error);
  process.exit(1);
});

async function startServer() {
  try {
    await startHttpServer({
      listen: () => app.listen({ host, port }),
      warmupEnabled: appServerWarmupEnabled,
      warmUp: async () => {
        const result = await agentRunner.warmUp();
        if (result && !result.ok) {
          app.log.warn({ error: result.error }, "Codex app-server warmup failed");
        }
      },
      onWarmupError: (error) => {
        app.log.warn({ error }, "Codex app-server warmup failed");
      },
    });
  } catch (error) {
    agentRunner.stop();
    throw error;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => {
      process.exit(0);
    });
  });
}

export type { PublicJob };

function defaultCodexBin() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe");
  }

  return "codex";
}

function parseAgentRunnerMode(value: string | undefined): AgentRunnerMode {
  if (value === undefined || value === "" || value === "app-server") return "app-server";
  if (value === "exec") return "exec";
  throw new Error(`WIKI_AGENT_RUNNER must be "app-server" or "exec": ${value}`);
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return parseRequiredPort(value, "WIKI_CODEX_APP_SERVER_PORT");
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRequiredPort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a valid TCP port: ${value}`);
  }
  const port = Number(value);
  if (!isValidPort(port)) {
    throw new Error(`${name} must be a valid TCP port: ${value}`);
  }
  return port;
}

function isValidPort(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}
