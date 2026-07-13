const assert = require("node:assert/strict");
const test = require("node:test");
const { createAutoLaunch } = require("./auto-launch.cjs");

test("Windows login launch starts the packaged app hidden", () => {
  let configured;
  const app = {
    getLoginItemSettings(options) {
      assert.equal(options.path, "C:\\Program Files\\Wiki Server\\Wiki Server.exe");
      assert.deepEqual(options.args, ["--hidden"]);
      return { openAtLogin: configured?.openAtLogin || false };
    },
    setLoginItemSettings(options) {
      configured = options;
    },
  };
  const autoLaunch = createAutoLaunch({
    app,
    platform: "win32",
    name: "local.wiki-server",
    executablePath: "C:\\Program Files\\Wiki Server\\Wiki Server.exe",
    args: ["--hidden"],
  });

  assert.equal(autoLaunch.getState().enabled, false);
  assert.equal(autoLaunch.setEnabled(true).enabled, true);
  assert.deepEqual(configured, {
    name: "local.wiki-server",
    path: "C:\\Program Files\\Wiki Server\\Wiki Server.exe",
    args: ["--hidden"],
    openAtLogin: true,
  });
});
