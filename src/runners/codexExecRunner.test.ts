import assert from "node:assert/strict";
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
