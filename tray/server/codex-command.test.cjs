const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveCodexCommand } = require("./codex-command.cjs");

test("uses an explicit Codex CLI path before the PATH command", () => {
  assert.equal(resolveCodexCommand({}), "codex");
  assert.equal(
    resolveCodexCommand({ CODEX_BIN: " C:\\tools\\codex.cmd " }),
    "C:\\tools\\codex.cmd",
  );
});
