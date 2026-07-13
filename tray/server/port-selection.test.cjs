const assert = require("node:assert/strict");
const test = require("node:test");
const { parseAppPort, selectServerPort } = require("./port-selection.cjs");

test("parses valid configured ports", () => {
  assert.equal(parseAppPort(undefined), undefined);
  assert.equal(parseAppPort(""), undefined);
  assert.equal(parseAppPort("55173"), 55173);
  assert.equal(parseAppPort("0"), undefined);
  assert.equal(parseAppPort("70000"), undefined);
});

test("uses the default port without a warning when it is available", async () => {
  const result = await selectServerPort("127.0.0.1", 55173, 55173, async () => true);
  assert.deepEqual(result, { port: 55173, warning: "" });
});

test("selects a nearby port and warns when the preferred port is occupied", async () => {
  const result = await selectServerPort(
    "127.0.0.1",
    55173,
    55173,
    async (_host, port) => port === 55175,
  );
  assert.equal(result.port, 55175);
  assert.match(result.warning, /55173 was already in use/);
});
