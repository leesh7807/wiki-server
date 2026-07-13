const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function getWikiGitState(wikiRoot, runGit = defaultRunGit) {
  try {
    const branch = runGit(wikiRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const head = runGit(wikiRoot, ["rev-parse", "--short", "HEAD"]).trim();
    const commitCount = Number.parseInt(runGit(wikiRoot, ["rev-list", "--count", "HEAD"]), 10);
    const changes = runGit(wikiRoot, ["status", "--porcelain"])
      .split(/\r?\n/)
      .filter(Boolean);
    return {
      available: true,
      branch,
      head,
      commitCount,
      changeCount: changes.length,
      clean: changes.length === 0,
      message: changes.length === 0 ? "Working tree clean" : `${changes.length} local change(s)`,
    };
  } catch (error) {
    return {
      available: false,
      branch: "",
      head: "",
      commitCount: 0,
      changeCount: 0,
      clean: false,
      message: error.message || String(error),
    };
  }
}

function getObsidianState(wikiRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return {
      installed: false,
      protocolRegistered: false,
      vaultRegistered: false,
      executablePath: "",
      message: `Obsidian detection is not supported on ${platform}.`,
    };
  }

  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const readFile = options.readFile || ((file) => fs.readFileSync(file, "utf8"));
  const protocolCommand = options.protocolCommand === undefined
    ? readObsidianProtocolCommand()
    : options.protocolCommand;
  const candidates = [
    extractExecutable(protocolCommand),
    path.join(env.LOCALAPPDATA || "", "Programs", "Obsidian", "Obsidian.exe"),
    path.join(env.LOCALAPPDATA || "", "Obsidian", "Obsidian.exe"),
    path.join(env.ProgramFiles || "", "Obsidian", "Obsidian.exe"),
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => exists(candidate)) || "";
  const configPath = path.join(env.APPDATA || "", "obsidian", "obsidian.json");
  const vaultRegistered = isRegisteredVault(configPath, wikiRoot, exists, readFile);
  const installed = Boolean(executablePath || protocolCommand);

  return {
    installed,
    protocolRegistered: Boolean(protocolCommand),
    vaultRegistered,
    executablePath,
    message: !installed
      ? "Obsidian이 설치되어 있지 않습니다."
      : vaultRegistered
        ? "운영 위키가 Obsidian Vault로 등록되어 있습니다."
        : "운영 위키 폴더를 Obsidian Vault로 한 번 등록해야 합니다.",
  };
}

function makeObsidianOpenUri(wikiRoot, page = "index.md") {
  return `obsidian://open?path=${encodeURIComponent(path.resolve(wikiRoot, page))}`;
}

function isRegisteredVault(configPath, wikiRoot, exists, readFile) {
  if (!configPath || !exists(configPath)) return false;
  try {
    const config = JSON.parse(readFile(configPath));
    const expected = normalizeWindowsPath(wikiRoot);
    return Object.values(config.vaults || {}).some((vault) =>
      normalizeWindowsPath(vault?.path || "") === expected);
  } catch {
    return false;
  }
}

function readObsidianProtocolCommand() {
  for (const key of [
    "HKCU\\Software\\Classes\\obsidian\\shell\\open\\command",
    "HKCR\\obsidian\\shell\\open\\command",
  ]) {
    try {
      const output = execFileSync("reg", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(/REG_SZ\s+(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      // Try the next registry view.
    }
  }
  return "";
}

function extractExecutable(command) {
  if (!command) return "";
  const quoted = command.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const plain = command.match(/^([^\s]+\.exe)/i);
  return plain?.[1] || "";
}

function normalizeWindowsPath(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function defaultRunGit(wikiRoot, args) {
  return execFileSync("git", ["-C", wikiRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

module.exports = { getObsidianState, getWikiGitState, makeObsidianOpenUri };
