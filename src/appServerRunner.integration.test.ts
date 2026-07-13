import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerManager } from "./appServerRunner.js";
import type { Job } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runIntegration = process.env.WIKI_RUN_CODEX_INTEGRATION === "1";

test(
  "installed codex app-server completes warmup and a real query job",
  { skip: runIntegration ? false : "set WIKI_RUN_CODEX_INTEGRATION=1 to run" },
  async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "wiki-server-codex-home-"));
    const wikiRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-server-wiki-root-"));
    const manager = new CodexAppServerManager();
    try {
      writeFileSync(
        path.join(wikiRoot, "AGENTS.md"),
        [
          "# Test Wiki",
          "",
          "This is an isolated integration-test wiki.",
          "For `/query`, answer the user directly and do not edit files.",
          "",
        ].join("\n"),
      );
      writeFileSync(path.join(wikiRoot, "index.md"), "# Test Wiki\n");

      const commonOptions = {
        codexBin: process.env.CODEX_BIN ?? defaultCodexBin(),
        wikiRoot,
        codexHome,
        model:
          process.env.WIKI_CODEX_QUERY_MODEL ??
          process.env.WIKI_CODEX_MODEL ??
          "gpt-5.6-terra",
        reasoningEffort:
          process.env.WIKI_CODEX_QUERY_REASONING_EFFORT ??
          process.env.WIKI_CODEX_REASONING_EFFORT ??
          "high",
        serviceTier: process.env.WIKI_CODEX_SERVICE_TIER || undefined,
      };

      const warmup = await manager.warmUp(commonOptions);
      assert.equal(warmup.ok, true);

      const running = manager.startJob(makeJob("query"), {
        ...commonOptions,
        onAgentEvent: () => undefined,
      });
      const result = await withTimeout(running.done, 120_000);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.result.lastAgentMessage ?? "", /WIKI_SERVER_APP_SERVER_INTEGRATION_OK/);
      }
    } finally {
      manager.stop();
      removeTree(codexHome);
      removeTree(wikiRoot);
    }
  },
);

function defaultCodexBin() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe");
  }

  return "codex";
}

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

function removeTree(target: string) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

function makeJob(command: Job["command"]): Job {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000003",
    command,
    content:
      "간단한 통합 테스트입니다. 위키를 수정하지 말고 WIKI_SERVER_APP_SERVER_INTEGRATION_OK 라고만 답하세요.",
    status: "running",
    createdAt: now,
    updatedAt: now,
    contentLength: 61,
    contentPreview: "간단한 통합 테스트입니다.",
  };
}
