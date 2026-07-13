import { existsSync } from "node:fs";
import path from "node:path";
import type { JobCommand } from "../jobs/jobTypes.js";

const DEFAULT_CODEX_MODELS: WikiCommandModels = {
  query: "gpt-5.6-terra",
  ingest: "gpt-5.6-sol",
  lint: "gpt-5.6-sol",
};

export type WikiServerPaths = {
  wikiRoot: string;
  wikiRootSource: "legacy-sibling" | "environment";
  dataDir: string;
  jobsDir: string;
  appServerCodexHome: string;
};

export type ResolveWikiServerPathsOptions = {
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
};

export function findPackageRoot(startDir: string) {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find wiki-server package root from: ${startDir}`);
    }
    current = parent;
  }
}

export type WikiCommandModels = Record<JobCommand, string>;
export type WikiCommandReasoningEfforts = Record<JobCommand, string>;

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env) {
  return optionalString(env.CODEX_BIN) ?? "codex";
}

export function resolveWikiCommandModels(
  env: NodeJS.ProcessEnv = process.env,
): WikiCommandModels {
  const fallback = optionalString(env.WIKI_CODEX_MODEL);
  return {
    query: optionalString(env.WIKI_CODEX_QUERY_MODEL) ?? fallback ?? DEFAULT_CODEX_MODELS.query,
    ingest: optionalString(env.WIKI_CODEX_INGEST_MODEL) ?? fallback ?? DEFAULT_CODEX_MODELS.ingest,
    lint: optionalString(env.WIKI_CODEX_LINT_MODEL) ?? fallback ?? DEFAULT_CODEX_MODELS.lint,
  };
}

export function resolveWikiCommandReasoningEfforts(
  env: NodeJS.ProcessEnv = process.env,
): WikiCommandReasoningEfforts {
  const fallback = optionalString(env.WIKI_CODEX_REASONING_EFFORT) ?? "high";
  return {
    query: optionalString(env.WIKI_CODEX_QUERY_REASONING_EFFORT) ?? fallback,
    ingest: optionalString(env.WIKI_CODEX_INGEST_REASONING_EFFORT) ?? fallback,
    lint: optionalString(env.WIKI_CODEX_LINT_REASONING_EFFORT) ?? fallback,
  };
}

export function resolveWikiServerPaths(
  options: ResolveWikiServerPathsOptions,
): WikiServerPaths {
  const env = options.env ?? process.env;
  const packageRoot = path.resolve(options.packageRoot);
  const wikiRoot = env.WIKI_ROOT
    ? path.resolve(env.WIKI_ROOT)
    : path.resolve(packageRoot, "..", "wiki");
  const wikiRootSource = env.WIKI_ROOT
    ? "environment"
    : "legacy-sibling";
  assertLooksLikeWikiRoot(wikiRoot);

  const dataDir = env.WIKI_SERVER_DATA_DIR
    ? path.resolve(env.WIKI_SERVER_DATA_DIR)
    : path.join(packageRoot, ".cache", "wiki-server");

  return {
    wikiRoot,
    wikiRootSource,
    dataDir,
    jobsDir: path.join(dataDir, "jobs"),
    appServerCodexHome: env.WIKI_CODEX_HOME
      ? path.resolve(env.WIKI_CODEX_HOME)
      : path.join(dataDir, "codex-home"),
  };
}

export function assertLooksLikeWikiRoot(wikiRoot: string) {
  const requiredPaths = [
    path.join(wikiRoot, "AGENTS.md"),
    path.join(wikiRoot, "index.md"),
    path.join(wikiRoot, "wiki"),
  ];
  const missing = requiredPaths.filter((candidate) => !existsSync(candidate));
  if (missing.length === 0) return;

  throw new Error(
    `WIKI_ROOT does not look like a wiki root: ${wikiRoot}. Missing: ${missing.join(", ")}`,
  );
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
