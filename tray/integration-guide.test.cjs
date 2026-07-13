const assert = require("node:assert/strict");
const test = require("node:test");
const { makeIntegrationGuide } = require("./integration-guide.cjs");

test("builds a concise repository guide from the active endpoint", () => {
  const guide = makeIntegrationGuide("http://127.0.0.1:55174");
  assert.match(guide, /Base URL: http:\/\/127\.0\.0\.1:55174/);
  assert.match(guide, /POST \/query/);
  assert.match(guide, /POST \/ingest/);
  assert.match(guide, /POST \/lint/);
  assert.match(guide, /GET \/jobs\/<jobId>/);
  assert.match(guide, /receiving repository decides when/);
  assert.equal(guide.split("\n").length <= 12, true);
});
