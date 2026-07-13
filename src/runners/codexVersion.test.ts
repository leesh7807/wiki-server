import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexVersion } from "./codexVersion.js";

test("reads and trims the installed Codex version", () => {
  assert.equal(
    resolveCodexVersion("codex", () => ({ status: 0, stdout: "codex-cli 1.2.3\n" })),
    "codex-cli 1.2.3",
  );
});

test("reports an unavailable Codex version without failing startup", () => {
  assert.equal(resolveCodexVersion("missing", () => ({ status: 1, stdout: "" })), undefined);
  assert.equal(
    resolveCodexVersion("missing", () => {
      throw new Error("not found");
    }),
    undefined,
  );
});
