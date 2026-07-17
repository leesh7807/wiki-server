import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installWikiRetrievalCommand } from "./wikiRetrievalCommand.js";

test("installs an agent-facing command that hides the internal loopback transport", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wiki-retrieval-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const directory = installWikiRetrievalCommand(root, "http://127.0.0.1:55173", "secret-token");
  const command = readFileSync(path.join(directory, "wiki-retrieval.cmd"), "utf8");
  const script = readFileSync(path.join(directory, "wiki-retrieval.ps1"), "utf8");

  assert.match(command, /wiki-retrieval\.ps1/);
  assert.match(script, /_internal\/retrieval\/search/);
  assert.match(script, /_internal\/retrieval\/read/);
  assert.match(script, /x-wiki-retrieval-token/);
  assert.match(script, /usage: wiki-retrieval search/);
  assert.match(script, /usage: wiki-retrieval read/);

  if (process.platform === "win32") {
    const parsed = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:WIKI_RETRIEVAL_SCRIPT, [ref]$null, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, WIKI_RETRIEVAL_SCRIPT: scriptPath(directory) },
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

function scriptPath(directory: string) {
  return path.join(directory, "wiki-retrieval.ps1");
}
