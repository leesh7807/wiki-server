import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveCodexCommand,
  resolveWikiCommandModels,
  resolveWikiCommandReasoningEfforts,
  resolveWikiServerPaths,
  findPackageRoot,
} from "./wikiServerConfig.js";

test("uses an explicit Codex CLI path before the PATH command", () => {
  assert.equal(resolveCodexCommand({}), "codex");
  assert.equal(resolveCodexCommand({ CODEX_BIN: " C:\\tools\\codex.cmd " }), "C:\\tools\\codex.cmd");
});

test("command models use the shared model default", () => {
  assert.deepEqual(resolveWikiCommandModels({}), {
    query: "gpt-5.6-terra",
    ingest: "gpt-5.6-sol",
    lint: "gpt-5.6-sol",
  });
  assert.deepEqual(resolveWikiCommandModels({ WIKI_CODEX_MODEL: " shared " }), {
    query: "shared",
    ingest: "shared",
    lint: "shared",
  });
});

test("command-specific models override the shared fallback independently", () => {
  assert.deepEqual(
    resolveWikiCommandModels({
      WIKI_CODEX_MODEL: "shared",
      WIKI_CODEX_QUERY_MODEL: "query-model",
      WIKI_CODEX_INGEST_MODEL: "ingest-model",
      WIKI_CODEX_LINT_MODEL: "lint-model",
    }),
    {
      query: "query-model",
      ingest: "ingest-model",
      lint: "lint-model",
    },
  );
});

test("command reasoning efforts override the shared fallback independently", () => {
  assert.deepEqual(resolveWikiCommandReasoningEfforts({}), {
    query: "high",
    ingest: "high",
    lint: "high",
  });
  assert.deepEqual(
    resolveWikiCommandReasoningEfforts({
      WIKI_CODEX_REASONING_EFFORT: "medium",
      WIKI_CODEX_QUERY_REASONING_EFFORT: "low",
      WIKI_CODEX_INGEST_REASONING_EFFORT: "high",
      WIKI_CODEX_LINT_REASONING_EFFORT: "xhigh",
    }),
    { query: "low", ingest: "high", lint: "xhigh" },
  );
});

test("finds the package root from source and compiled module depths", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wiki-server-package-root-"));
  const packageRoot = path.join(parent, "wiki-server");
  const sourceDir = path.join(packageRoot, "src");
  const compiledDir = path.join(packageRoot, "dist", "src");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(compiledDir, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), "{}", "utf8");

  try {
    assert.equal(findPackageRoot(sourceDir), packageRoot);
    assert.equal(findPackageRoot(compiledDir), packageRoot);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("falls back to the sibling wiki during migration", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wiki-server-config-"));
  const packageRoot = path.join(parent, "wiki-server");
  const wikiRoot = path.join(parent, "wiki");
  mkdirSync(packageRoot, { recursive: true });
  makeWikiRoot(wikiRoot);

  try {
    const paths = resolveWikiServerPaths({ packageRoot, env: {} });

    assert.equal(paths.wikiRoot, wikiRoot);
    assert.equal(paths.wikiRootSource, "legacy-sibling");
    assert.equal(paths.dataDir, path.join(packageRoot, ".cache", "wiki-server"));
    assert.equal(paths.jobsDir, path.join(packageRoot, ".cache", "wiki-server", "jobs"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("environment overrides wiki root and server-owned data directories", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wiki-server-config-"));
  const packageRoot = path.join(parent, "wiki-server");
  const wikiRoot = path.join(parent, "custom-wiki");
  const dataDir = path.join(parent, "runtime");
  const codexHome = path.join(parent, "codex-home");
  mkdirSync(packageRoot, { recursive: true });
  makeWikiRoot(wikiRoot);

  try {
    const paths = resolveWikiServerPaths({
      packageRoot,
      env: {
        WIKI_ROOT: wikiRoot,
        WIKI_SERVER_DATA_DIR: dataDir,
        WIKI_CODEX_HOME: codexHome,
      },
    });

    assert.equal(paths.wikiRoot, wikiRoot);
    assert.equal(paths.wikiRootSource, "environment");
    assert.equal(paths.dataDir, dataDir);
    assert.equal(paths.jobsDir, path.join(dataDir, "jobs"));
    assert.equal(paths.appServerCodexHome, codexHome);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("invalid wiki root fails before the server starts", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wiki-server-config-"));
  const packageRoot = path.join(parent, "wiki-server");
  mkdirSync(packageRoot, { recursive: true });

  try {
    assert.throws(
      () => resolveWikiServerPaths({ packageRoot, env: {} }),
      /does not look like a wiki root/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function makeWikiRoot(wikiRoot: string) {
  mkdirSync(path.join(wikiRoot, "wiki"), { recursive: true });
  writeFileSync(path.join(wikiRoot, "AGENTS.md"), "# Test Wiki\n", "utf8");
  writeFileSync(path.join(wikiRoot, "index.md"), "# Test Wiki\n", "utf8");
}
