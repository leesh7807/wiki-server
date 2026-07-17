const os = require("node:os");
const path = require("node:path");

function resolvePackagedDataRoot(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();

  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Wiki Server");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Wiki Server");
  }

  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "wiki-server");
}

module.exports = { resolvePackagedDataRoot };
