import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentRunner, type AgentRunnerMode } from "./runners/agentRunner.js";
import { resolveCodexVersion } from "./runners/codexVersion.js";
import {
  resolveWikiCommandModels,
  resolveWikiCommandReasoningEfforts,
  resolveCodexCommand,
  resolveWikiServerPaths,
  findPackageRoot,
} from "./config/wikiServerConfig.js";
import { JobStore } from "./jobs/jobStore.js";
import { startHttpServer } from "./http/serverStartup.js";
import { createWikiHttpServer } from "./http/wikiHttpServer.js";
import type { PublicJob } from "./jobs/jobTypes.js";
import { formatJobInput } from "./jobs/jobCommand.js";
import { WikiRetriever } from "./retrieval/wikiRetrieval.js";
import { installWikiRetrievalCommand } from "./retrieval/wikiRetrievalCommand.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = findPackageRoot(__dirname);
const paths = resolveWikiServerPaths({ packageRoot });

const wikiRoot = paths.wikiRoot;
const port = parseRequiredPort(process.env.PORT ?? "55173", "PORT");
const host = process.env.HOST ?? "127.0.0.1";
const codexBin = resolveCodexCommand();
const codexVersion = resolveCodexVersion(codexBin);
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
const graphRetrievalEnabled = process.env.WIKI_GRAPH_RETRIEVAL !== "0";
const eventLogCompressionEnabled = process.env.WIKI_SERVER_COMPRESS_EVENT_LOGS !== "0";
const retrievalHost = host === "0.0.0.0" || host === "::"
  ? "127.0.0.1"
  : host.includes(":") ? `[${host}]` : host;
const retrievalBaseUrl = `http://${retrievalHost}:${port}`;
const retrievalToken = randomUUID();
const retrievalToolDirectory = graphRetrievalEnabled
  ? installWikiRetrievalCommand(paths.dataDir, retrievalBaseUrl, retrievalToken)
  : undefined;
const wikiRetriever = new WikiRetriever(wikiRoot, {
  retrievalCommand: retrievalToolDirectory ? "wiki-retrieval" : undefined,
});

const agentRunner = new AgentRunner({
  mode: agentRunnerMode,
  codexBin,
  codexVersion,
  wikiRoot,
  appServerCodexHome,
  appServerPort,
  appServerReservedPorts: [port],
  appServerModels,
  appServerReasoningEfforts,
  appServerServiceTier,
  warmupEnabled: appServerWarmupEnabled,
  toolPath: retrievalToolDirectory,
});

const store = new JobStore({
  jobsDir,
  heartbeatMs,
  compressEventLogs: eventLogCompressionEnabled,
  startRunner: (job, hooks) => {
    if (!graphRetrievalEnabled) return agentRunner.startJob(job, hooks);
    try {
      const retrieval = wikiRetriever.build(job);
      hooks.onAgentEvent(retrieval.event);
      return agentRunner.startJob(
        job,
        hooks,
        formatJobInput(job.command, job.content, retrieval.context),
      );
    } catch (error) {
      hooks.onAgentEvent({
        type: "retrieval_context_failed",
        strategy: "wiki-graph-v1",
        error: error instanceof Error ? error.message : String(error),
      });
      return agentRunner.startJob(job, hooks);
    }
  },
});

const app = createWikiHttpServer({
  store,
  logger: httpLoggerEnabled,
  retrieval: graphRetrievalEnabled
    ? {
        token: retrievalToken,
        search: (input) => wikiRetriever.search(input),
        read: (input) => wikiRetriever.read(input),
      }
    : undefined,
  health: () => ({
    ok: true,
    wikiRoot,
    wikiRootSource: paths.wikiRootSource,
    dataDir: paths.dataDir,
    heartbeatMs,
    httpLoggerEnabled,
    graphRetrieval: {
      enabled: graphRetrievalEnabled,
      strategy: "wiki-graph-v1",
    },
    eventLogCompressionEnabled,
    agentRunner: agentRunner.status(),
  }),
});

app.addHook("onClose", () => {
  agentRunner.stop();
});

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
