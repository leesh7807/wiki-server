import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeCodexEnvironment } from "./codexExecRunner.js";

test("exec runner uses the isolated Codex home without dropping inherited environment", () => {
  const environment = makeCodexEnvironment("C:\\runtime\\codex-home", {
    PATH: "C:\\tools",
    CODEX_HOME: "C:\\Users\\someone\\.codex",
  });

  assert.equal(environment.CODEX_HOME, "C:\\runtime\\codex-home");
  assert.equal(environment.PATH, "C:\\tools");
});

test("exec runner prepends the internal wiki tool directory", () => {
  const environment = makeCodexEnvironment(
    "C:\\runtime\\codex-home",
    { Path: "C:\\Windows\\System32" },
    "C:\\runtime\\wiki-tools",
  );

  assert.equal(environment.Path, `C:\\runtime\\wiki-tools${path.delimiter}C:\\Windows\\System32`);
});
