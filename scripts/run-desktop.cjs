const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");
const { resolvePackagedDataRoot } = require("../tray/system/data-paths.cjs");
const { ensurePackagedWikiRoot } = require("../tray/wiki/wiki-installation.cjs");

const packageRoot = path.resolve(__dirname, "..");
const dataRoot = resolvePackagedDataRoot();
const wikiRoot = path.join(dataRoot, "wiki-root");
const runtimeRoot = path.join(dataRoot, "runtime");
const prepareResult = spawnSync(process.execPath, [path.join(packageRoot, "tray", "prepare-wiki-seed.cjs")], {
  cwd: packageRoot,
  stdio: "inherit",
});
if (prepareResult.status !== 0) {
  process.exit(prepareResult.status ?? 1);
}

ensurePackagedWikiRoot({
  contentSeed: path.join(packageRoot, "wiki-template"),
  dataRoot,
  gitSeed: path.join(packageRoot, ".cache", "wiki-git-seed"),
  wikiRoot,
});

const child = spawn(
  electronPath,
  [path.join(packageRoot, "tray", "main.cjs"), ...process.argv.slice(2)],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      WIKI_MANAGED_SOURCE: "1",
      WIKI_SOURCE_LAUNCHER_EXECUTABLE: process.execPath,
      WIKI_SOURCE_LAUNCHER_SCRIPT: __filename,
      WIKI_ROOT: wikiRoot,
      WIKI_SERVER_DATA_DIR: runtimeRoot,
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
