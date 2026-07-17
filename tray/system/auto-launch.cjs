const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createAutoLaunch(options) {
  const platform = options.platform || process.platform;
  if (platform === "win32" || platform === "darwin") {
    return createElectronLoginItemAutoLaunch(options, platform);
  }
  if (platform === "linux") {
    return createLinuxAutoLaunch(options, platform);
  }
  return createUnsupportedAutoLaunch(platform);
}

function resolveAutoLaunchTarget(options) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (
    options.managedSourceLaunch
    && env.WIKI_SOURCE_LAUNCHER_EXECUTABLE
    && env.WIKI_SOURCE_LAUNCHER_SCRIPT
  ) {
    return {
      executablePath: env.WIKI_SOURCE_LAUNCHER_EXECUTABLE,
      args: [env.WIKI_SOURCE_LAUNCHER_SCRIPT, "--hidden"],
    };
  }
  if (platform === "linux" && env.APPIMAGE) {
    return { executablePath: env.APPIMAGE, args: ["--hidden"] };
  }
  return { executablePath: options.executablePath, args: ["--hidden"] };
}

function createElectronLoginItemAutoLaunch(options, platform) {
  const loginItemOptions = {
    name: options.name || "local.wiki-server",
    path: options.executablePath,
    args: options.args || [],
  };

  return {
    getState() {
      return {
        enabled: Boolean(options.app.getLoginItemSettings(loginItemOptions).openAtLogin),
        supported: true,
        platform,
        message: "",
      };
    },
    setEnabled(enabled) {
      options.app.setLoginItemSettings({
        ...loginItemOptions,
        openAtLogin: Boolean(enabled),
      });
      return this.getState();
    },
  };
}

function createLinuxAutoLaunch(options, platform) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const autostartPath = path.join(configHome, "autostart", "local.wiki-server.desktop");
  const command = [options.executablePath, ...(options.args || [])]
    .map(quoteDesktopExecArgument)
    .join(" ");

  return {
    getState() {
      return {
        enabled: fs.existsSync(autostartPath),
        supported: true,
        platform,
        message: "",
      };
    },
    setEnabled(enabled) {
      if (!enabled) {
        fs.rmSync(autostartPath, { force: true });
        return this.getState();
      }

      fs.mkdirSync(path.dirname(autostartPath), { recursive: true });
      const content = [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.0",
        "Name=Wiki Server",
        "Comment=Start the local Wiki Server in the background",
        `Exec=${command}`,
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n");
      const staging = `${autostartPath}.tmp`;
      fs.writeFileSync(staging, content, { encoding: "utf8", mode: 0o644 });
      fs.renameSync(staging, autostartPath);
      return this.getState();
    },
  };
}

function quoteDesktopExecArgument(value) {
  return `"${String(value).replace(/[\\"`$]/g, "\\$&")}"`;
}

function createUnsupportedAutoLaunch(platform) {
  const message = `Auto-start is not supported on ${platform}.`;
  return {
    getState() {
      return {
        enabled: false,
        supported: false,
        platform,
        message,
      };
    },
    setEnabled() {
      return this.getState();
    },
  };
}

module.exports = { createAutoLaunch, resolveAutoLaunchTarget };
