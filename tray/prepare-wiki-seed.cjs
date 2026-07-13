const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const wikiTemplate = path.join(packageRoot, "wiki-template");
const repositoryRoot = path.join(packageRoot, ".cache", "wiki-template-repository");
const gitRoot = path.join(repositoryRoot, ".git");
const seedRoot = path.join(packageRoot, ".cache", "wiki-git-seed");

if (!fs.existsSync(path.join(wikiTemplate, "AGENTS.md"))) {
  throw new Error(`Wiki template is incomplete: ${wikiTemplate}`);
}

fs.rmSync(repositoryRoot, { recursive: true, force: true });
fs.rmSync(seedRoot, { recursive: true, force: true });
fs.cpSync(wikiTemplate, repositoryRoot, { recursive: true });
git(["init", "--initial-branch=main"]);
git(["config", "user.name", "Wiki Server"]);
git(["config", "user.email", "local@wiki-server"]);
git(["add", "--all"]);
git(["commit", "-m", "Initialize local wiki"], {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});
const head = git(["rev-parse", "HEAD"]).trim();
fs.mkdirSync(path.dirname(seedRoot), { recursive: true });
fs.cpSync(gitRoot, seedRoot, {
  recursive: true,
  filter(source) {
    return !source.endsWith(".lock");
  },
});
fs.rmSync(repositoryRoot, { recursive: true, force: true });

console.log(`wiki Git seed prepared: ${head}`);

function git(args, extraEnv = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
}
