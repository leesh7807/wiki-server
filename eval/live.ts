import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JobCommand = "query" | "ingest" | "lint";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

type LiveEvalCase = {
  id: string;
  command: JobCommand;
  content?: string;
  mode: "live";
  expected: {
    status: JobStatus;
    requiredLastAgentMessagePatterns?: string[];
    forbiddenLastAgentMessagePatterns?: string[];
  };
};

type EnqueueResponse = {
  jobId: string;
  status: JobStatus;
  eventsUrl: string;
};

type PublicJob = {
  id: string;
  status: JobStatus;
  result?: {
    lastAgentMessage?: string;
  };
  error?: {
    message?: string;
    lastAgentMessage?: string;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const baseUrl = process.env.WIKI_SERVER_BASE_URL ?? "http://127.0.0.1:55173";
const liveEnabled =
  process.env.WIKI_RUN_CODEX_INTEGRATION === "1" ||
  process.env.WIKI_RUN_WIKI_SERVER_LIVE_EVAL === "1";

if (!liveEnabled) {
  console.log(
    "live eval skipped; set WIKI_RUN_CODEX_INTEGRATION=1 or WIKI_RUN_WIKI_SERVER_LIVE_EVAL=1",
  );
  process.exit(0);
}

const cases = loadLiveCases(path.join(packageRoot, "eval", "cases"));
if (cases.length === 0) {
  console.log("live eval skipped; no live cases found");
  process.exit(0);
}

const failures: string[] = [];
for (const evalCase of cases) {
  const job = await runLiveCase(evalCase);
  const caseFailures = gradeLiveCase(evalCase, job);
  if (caseFailures.length > 0) {
    failures.push(`${evalCase.id}: ${caseFailures.join("; ")}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`live eval: ${cases.length}/${cases.length} passed`);

function loadLiveCases(casesDir: string): LiveEvalCase[] {
  return readdirSync(casesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => JSON.parse(readFileSync(path.join(casesDir, fileName), "utf8")) as LiveEvalCase)
    .filter((evalCase) => evalCase.mode === "live");
}

async function runLiveCase(evalCase: LiveEvalCase): Promise<PublicJob> {
  const pathName = `/${evalCase.command}`;
  const body = evalCase.command === "lint" ? {} : { content: evalCase.content ?? "" };
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) {
    throw new Error(`${evalCase.id}: enqueue failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const enqueued = (await response.json()) as EnqueueResponse;
  return pollJob(enqueued.jobId);
}

async function pollJob(jobId: string): Promise<PublicJob> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`);
    if (!response.ok) {
      throw new Error(`job ${jobId}: HTTP ${response.status}: ${await response.text()}`);
    }
    const job = (await response.json()) as PublicJob;
    if (isTerminal(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`job ${jobId}: timed out waiting for terminal status`);
}

function gradeLiveCase(evalCase: LiveEvalCase, job: PublicJob) {
  const failures: string[] = [];
  if (job.status !== evalCase.expected.status) {
    failures.push(`status expected ${evalCase.expected.status}, got ${job.status}`);
  }

  const lastAgentMessage = job.result?.lastAgentMessage ?? job.error?.lastAgentMessage ?? "";
  for (const pattern of evalCase.expected.requiredLastAgentMessagePatterns ?? []) {
    if (!new RegExp(pattern, "iu").test(lastAgentMessage)) {
      failures.push(`lastAgentMessage did not match required pattern: ${pattern}`);
    }
  }
  for (const pattern of evalCase.expected.forbiddenLastAgentMessagePatterns ?? []) {
    if (new RegExp(pattern, "iu").test(lastAgentMessage)) {
      failures.push(`lastAgentMessage matched forbidden pattern: ${pattern}`);
    }
  }
  if (job.error?.message) {
    failures.push(`job error: ${job.error.message}`);
  }
  return failures;
}

function isTerminal(status: JobStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
