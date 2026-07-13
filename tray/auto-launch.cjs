function createAutoLaunch(options) {
  const platform = options.platform || process.platform;
  if (platform === "win32" || platform === "darwin") {
    return createElectronLoginItemAutoLaunch(options, platform);
  }
  if (platform === "linux") {
    return createLinuxAutoLaunchStub(platform);
  }
  return createUnsupportedAutoLaunch(platform);
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

function createLinuxAutoLaunchStub(platform) {
  const message = "Linux auto-start needs an XDG autostart .desktop adapter.";
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

module.exports = { createAutoLaunch };
