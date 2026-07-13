import assert from "node:assert/strict";
import test from "node:test";
import { formatJobInput, parseCommandContent } from "./jobCommand.js";

test("formats empty lint command without a trailing argument", () => {
  assert.equal(formatJobInput("lint", ""), "/lint");
  assert.equal(formatJobInput("lint", "   \n\t"), "/lint");
});

test("formats lint as the canonical whole-wiki command even if content is passed", () => {
  assert.equal(formatJobInput("lint", "focus on source pages"), "/lint");
});

test("formats query and ingest with existing trailing content behavior", () => {
  assert.equal(formatJobInput("query", "what changed?"), "/query what changed?");
  assert.equal(formatJobInput("ingest", "inbox/source.md"), "/ingest inbox/source.md");
  assert.equal(formatJobInput("query", ""), "/query ");
});

test("parses lint request bodies with optional content", () => {
  assert.deepEqual(parseCommandContent("lint", undefined), { ok: true, content: "" });
  assert.deepEqual(parseCommandContent("lint", {}), { ok: true, content: "" });
  assert.deepEqual(parseCommandContent("lint", { content: "" }), { ok: true, content: "" });
  assert.deepEqual(parseCommandContent("lint", { content: "   \n\t" }), { ok: true, content: "" });
});

test("rejects invalid lint request bodies", () => {
  assert.equal(parseCommandContent("lint", null).ok, false);
  assert.equal(parseCommandContent("lint", { content: 1 }).ok, false);
  assert.equal(parseCommandContent("lint", { content: "context" }).ok, false);
  assert.equal(parseCommandContent("lint", { context: "typo" }).ok, false);
});

test("query and ingest still require non-empty string content", () => {
  assert.deepEqual(parseCommandContent("query", { content: "question" }), {
    ok: true,
    content: "question",
  });
  assert.deepEqual(parseCommandContent("ingest", { content: "source" }), {
    ok: true,
    content: "source",
  });
  assert.equal(parseCommandContent("query", undefined).ok, false);
  assert.equal(parseCommandContent("query", {}).ok, false);
  assert.equal(parseCommandContent("query", { content: "" }).ok, false);
  assert.equal(parseCommandContent("ingest", { content: "" }).ok, false);
});
