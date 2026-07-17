const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAutoLaunch, resolveAutoLaunchTarget } = require("./auto-launch.cjs");

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

test("Linux login launch uses an XDG autostart entry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-autostart-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const autoLaunch = createAutoLaunch({
    app: {},
    platform: "linux",
    executablePath: "/opt/Wiki Server/wiki-server",
    args: ["--hidden"],
    env: {},
    home,
  });

  assert.deepEqual(autoLaunch.getState(), {
    enabled: false,
    supported: true,
    platform: "linux",
    message: "",
  });
  assert.equal(autoLaunch.setEnabled(true).enabled, true);
  const desktopFile = path.join(home, ".config", "autostart", "local.wiki-server.desktop");
  const content = fs.readFileSync(desktopFile, "utf8");
  assert.match(content, /^\[Desktop Entry\]$/m);
  assert.match(content, /^Exec="\/opt\/Wiki Server\/wiki-server" "--hidden"$/m);
  assert.equal(autoLaunch.setEnabled(false).enabled, false);
  assert.equal(fs.existsSync(desktopFile), false);
});

test("Linux AppImage login launch keeps the original AppImage path", () => {
  assert.deepEqual(resolveAutoLaunchTarget({
    platform: "linux",
    env: { APPIMAGE: "/home/user/Applications/Wiki Server.AppImage" },
    executablePath: "/tmp/.mount_Wiki/wiki-server",
  }), {
    executablePath: "/home/user/Applications/Wiki Server.AppImage",
    args: ["--hidden"],
  });
});

test("managed source login launch re-enters the managed source launcher", () => {
  assert.deepEqual(resolveAutoLaunchTarget({
    platform: "win32",
    env: {
      WIKI_SOURCE_LAUNCHER_EXECUTABLE: "C:\\Program Files\\nodejs\\node.exe",
      WIKI_SOURCE_LAUNCHER_SCRIPT: "C:\\src\\wiki-server\\scripts\\run-desktop.cjs",
    },
    managedSourceLaunch: true,
    executablePath: "C:\\src\\wiki-server\\node_modules\\electron\\electron.exe",
  }), {
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\src\\wiki-server\\scripts\\run-desktop.cjs", "--hidden"],
  });
});
