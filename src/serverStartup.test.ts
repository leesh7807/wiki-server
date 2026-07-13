import assert from "node:assert/strict";
import test from "node:test";
import { startHttpServer } from "./serverStartup.js";

test("opens HTTP before waiting for model warmup", async () => {
  let listened = false;
  let finishWarmup: () => void = () => undefined;
  const warmup = new Promise<void>((resolve) => {
    finishWarmup = resolve;
  });

  const started = startHttpServer({
    listen: async () => {
      listened = true;
    },
    warmupEnabled: true,
    warmUp: () => warmup,
    onWarmupError: () => undefined,
  });

  await Promise.resolve();
  assert.equal(listened, true);
  finishWarmup();
  await started;
});

test("reports warmup failures without failing the listening server", async () => {
  const failures: unknown[] = [];
  await startHttpServer({
    listen: async () => undefined,
    warmupEnabled: true,
    warmUp: async () => {
      throw new Error("warmup failed");
    },
    onWarmupError: (error) => failures.push(error),
  });

  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /warmup failed/);
});
