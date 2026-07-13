import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runReplayEvaluation } from "./replay.js";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), "..");

test("replay evaluation grades fixture jobs and writes a report", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "wiki-server-eval-"));
  try {
    const report = await runReplayEvaluation({ packageRoot, dataDir });

    assert.equal(report.totals.cases, 3);
    assert.equal(report.totals.failed, 0);
    assert.equal(report.totals.passed, 3);
    assert.equal(existsSync(report.reportPath), true);
    assert.equal(report.reportPath.startsWith(path.join(dataDir, "eval-reports")), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
