const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolvePackagedDataRoot } = require("./data-paths.cjs");

test("uses LocalAppData for packaged Windows data", () => {
  assert.equal(resolvePackagedDataRoot({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    home: "C:\\Users\\test",
  }), path.join("C:\\Users\\test\\AppData\\Local", "Wiki Server"));
});

test("uses XDG_DATA_HOME for packaged Linux data", () => {
  assert.equal(resolvePackagedDataRoot({
    platform: "linux",
    env: { XDG_DATA_HOME: "/home/test/.data" },
    home: "/home/test",
  }), path.join("/home/test/.data", "wiki-server"));
});

test("falls back to the standard Linux user data directory", () => {
  assert.equal(resolvePackagedDataRoot({
    platform: "linux",
    env: {},
    home: "/home/test",
  }), path.join("/home/test", ".local", "share", "wiki-server"));
});
