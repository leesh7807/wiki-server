import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JobCommand = "query" | "ingest" | "lint";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

type EvalCase = {
  id: string;
  description?: string;
  command: JobCommand;
  content?: string;
  mode?: "replay" | "live";
  fixtureJobId?: string;
  fixture?: {
    metaPath: string;
    eventsPath?: string;
  };
  expected: {
    status: JobStatus;
    requiredLastAgentMessagePatterns?: string[];
    forbiddenLastAgentMessagePatterns?: string[];
    eventTypes?: string[];
    fileObservability?: {
      readIncludes?: string[];
      writeIncludes?: string[];
      ambiguousIncludes?: string[];
    };
  };
};

type PublicJob = {
  id: string;
  command: JobCommand;
  status: JobStatus;
  result?: {
    lastAgentMessage?: string;
  };
  error?: {
    lastAgentMessage?: string;
    message?: string;
  };
  metrics?: {
    fileObservability?: {
      readFilePaths?: string[];
      writeFilePaths?: string[];
      ambiguousFilePaths?: string[];
    };
  };
};

type EvalResult = {
  id: string;
  passed: boolean;
  failures: string[];
};

type EvalReport = {
  generatedAt: string;
  mode: "replay";
  totals: {
    cases: number;
    passed: number;
    failed: number;
  };
  results: EvalResult[];
  reportPath: string;
};

export type ReplayEvaluationOptions = {
  packageRoot: string;
  casesDir?: string;
  fixturesJobsDir?: string;
  dataDir?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPackageRoot = path.resolve(__dirname, "..");

export async function runReplayEvaluation(
  options: ReplayEvaluationOptions,
): Promise<EvalReport> {
  const packageRoot = path.resolve(options.packageRoot);
  const casesDir = options.casesDir ?? path.join(packageRoot, "eval", "cases");
  const fixturesJobsDir = options.fixturesJobsDir ?? path.join(packageRoot, "eval", "fixtures", "jobs");
  const dataDir =
    options.dataDir ??
    (process.env.WIKI_SERVER_DATA_DIR
      ? path.resolve(process.env.WIKI_SERVER_DATA_DIR)
      : path.join(packageRoot, ".cache", "wiki-server"));

  const cases = loadReplayCases(casesDir);
  const results = cases.map((evalCase) => evaluateCase(evalCase, fixturesJobsDir));
  const reportPath = writeReport(dataDir, results);
  return {
    generatedAt: new Date().toISOString(),
    mode: "replay",
    totals: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
    reportPath,
  };
}

function loadReplayCases(casesDir: string): EvalCase[] {
  const cases = readdirSync(casesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const fullPath = path.join(casesDir, fileName);
      return JSON.parse(readFileSync(fullPath, "utf8")) as EvalCase;
    })
    .filter((evalCase) => (evalCase.mode ?? "replay") === "replay");

  if (cases.length === 0) {
    throw new Error(`no replay eval cases found in ${casesDir}`);
  }
  return cases;
}

function evaluateCase(evalCase: EvalCase, fixturesJobsDir: string): EvalResult {
  const failures: string[] = [];
  const job = readFixtureJob(evalCase, fixturesJobsDir, failures);
  const events = readFixtureEvents(evalCase, fixturesJobsDir, failures);
  if (!job) {
    return { id: evalCase.id, passed: false, failures };
  }

  expectEqual(failures, "command", job.command, evalCase.command);
  expectEqual(failures, "status", job.status, evalCase.expected.status);

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

  const eventTypes = new Set(events.map((event) => event.event).filter(Boolean));
  for (const eventType of evalCase.expected.eventTypes ?? []) {
    if (!eventTypes.has(eventType)) {
      failures.push(`missing event type: ${eventType}`);
    }
  }

  const fileObservability = job.metrics?.fileObservability;
  expectIncludes(
    failures,
    "readFilePaths",
    fileObservability?.readFilePaths,
    evalCase.expected.fileObservability?.readIncludes,
  );
  expectIncludes(
    failures,
    "writeFilePaths",
    fileObservability?.writeFilePaths,
    evalCase.expected.fileObservability?.writeIncludes,
  );
  expectIncludes(
    failures,
    "ambiguousFilePaths",
    fileObservability?.ambiguousFilePaths,
    evalCase.expected.fileObservability?.ambiguousIncludes,
  );

  return {
    id: evalCase.id,
    passed: failures.length === 0,
    failures,
  };
}

function readFixtureJob(
  evalCase: EvalCase,
  fixturesJobsDir: string,
  failures: string[],
): PublicJob | undefined {
  const metaPath = resolveFixtureMetaPath(evalCase, fixturesJobsDir);
  if (!existsSync(metaPath)) {
    failures.push(`missing fixture meta: ${metaPath}`);
    return undefined;
  }
  return JSON.parse(readFileSync(metaPath, "utf8")) as PublicJob;
}

function readFixtureEvents(
  evalCase: EvalCase,
  fixturesJobsDir: string,
  failures: string[],
): Array<{ event?: string }> {
  const eventsPath = resolveFixtureEventsPath(evalCase, fixturesJobsDir);
  if (!eventsPath || !existsSync(eventsPath)) return [];

  return readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as { event?: string };
      } catch {
        failures.push(`invalid JSONL event at ${eventsPath}:${index + 1}`);
        return {};
      }
    });
}

function resolveFixtureMetaPath(evalCase: EvalCase, fixturesJobsDir: string) {
  if (evalCase.fixture?.metaPath) return path.resolve(evalCase.fixture.metaPath);
  if (!evalCase.fixtureJobId) {
    throw new Error(`eval case ${evalCase.id} must include fixtureJobId or fixture.metaPath`);
  }
  return path.join(fixturesJobsDir, `${evalCase.fixtureJobId}.meta.json`);
}

function resolveFixtureEventsPath(evalCase: EvalCase, fixturesJobsDir: string) {
  if (evalCase.fixture?.eventsPath) return path.resolve(evalCase.fixture.eventsPath);
  if (!evalCase.fixtureJobId) return undefined;
  return path.join(fixturesJobsDir, "raw-events", `${evalCase.fixtureJobId}.jsonl`);
}

function expectEqual<T>(failures: string[], label: string, actual: T, expected: T) {
  if (actual === expected) return;
  failures.push(`${label} expected ${String(expected)}, got ${String(actual)}`);
}

function expectIncludes(
  failures: string[],
  label: string,
  actual: string[] | undefined,
  expected: string[] | undefined,
) {
  for (const expectedValue of expected ?? []) {
    if (actual?.includes(expectedValue)) continue;
    failures.push(`${label} missing ${expectedValue}`);
  }
}

function writeReport(dataDir: string, results: EvalResult[]) {
  const reportsDir = path.join(dataDir, "eval-reports");
  mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `replay-${timestamp}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "replay",
    totals: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runReplayEvaluation({ packageRoot: defaultPackageRoot })
    .then((report) => {
      console.log(
        `replay eval: ${report.totals.passed}/${report.totals.cases} passed; report=${report.reportPath}`,
      );
      for (const result of report.results) {
        if (result.passed) continue;
        console.error(`${result.id}: ${result.failures.join("; ")}`);
      }
      process.exitCode = report.totals.failed === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
