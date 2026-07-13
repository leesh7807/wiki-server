const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const wikiRoot = path.join(packageRoot, "wiki-root");
const gitRoot = path.join(wikiRoot, ".git");
const seedRoot = path.join(packageRoot, ".cache", "wiki-git-seed");

if (!fs.existsSync(gitRoot)) {
  throw new Error(`Nested wiki Git repository is missing: ${gitRoot}`);
}

const status = git(["status", "--porcelain"]);
if (status.trim()) {
  throw new Error(`Nested wiki must be clean before packaging:\n${status}`);
}

const head = git(["rev-parse", "HEAD"]).trim();
fs.rmSync(seedRoot, { recursive: true, force: true });
fs.mkdirSync(path.dirname(seedRoot), { recursive: true });
fs.cpSync(gitRoot, seedRoot, {
  recursive: true,
  filter(source) {
    return !source.endsWith(".lock");
  },
});

console.log(`wiki Git seed prepared: ${head}`);

function git(args) {
  return execFileSync("git", ["-C", wikiRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}
