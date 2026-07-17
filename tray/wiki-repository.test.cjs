const assert = require("node:assert/strict");
const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageRoot = path.resolve(__dirname, "..");
const packageConfig = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const gitignore = readFileSync(path.join(packageRoot, ".gitignore"), "utf8");
const main = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const installation = readFileSync(path.join(__dirname, "wiki", "wiki-installation.cjs"), "utf8");
const sourceLauncher = readFileSync(path.join(packageRoot, "scripts", "run-desktop.cjs"), "utf8");

test("server tracks only a minimal wiki template", () => {
  assert.doesNotMatch(gitignore, /^\/wiki-template\/$/m);
  assert.equal(existsSync(path.join(packageRoot, "wiki-root")), false);
  assert.match(main, /wiki-git-seed/);
  assert.match(main, /ensurePackagedWikiRoot/);
  assert.match(installation, /ensureWikiGitRepository/);
  for (const directory of ["exports", "inbox", "raw/assets", "raw/sources", "wiki/concepts", "wiki/decisions", "wiki/entities", "wiki/maps", "wiki/projects", "wiki/sources"]) {
    assert.equal(statSync(path.join(packageRoot, "wiki-template", directory, ".gitkeep")).size, 0);
  }
});

test("packaging carries wiki content and renamed Git history separately", () => {
  const resources = packageConfig.build.extraResources;
  assert.ok(resources.some((entry) => entry.to === "wiki-root-seed"));
  assert.ok(resources.some((entry) => entry.to === "wiki-git-seed"));
  const contentSeed = resources.find((entry) => entry.to === "wiki-root-seed");
  assert.equal(contentSeed.from, "wiki-template");
});

test("packaging supports Windows and Linux desktop artifacts", () => {
  assert.equal(packageConfig.desktopName, "local.wiki-server.desktop");
  assert.equal(packageConfig.build.win.target, "nsis");
  assert.deepEqual(packageConfig.build.linux.target, ["AppImage", "deb"]);
  assert.equal(packageConfig.build.linux.icon, "tray/icon.png");
  assert.equal(packageConfig.build.linux.syncDesktopName, true);
  assert.equal(existsSync(path.join(packageRoot, "tray", "icon.png")), true);
});

test("source launcher initializes the same durable wiki boundary before opening Electron", () => {
  assert.equal(packageConfig.scripts.app, "node scripts/run-desktop.cjs");
  assert.match(sourceLauncher, /resolvePackagedDataRoot/);
  assert.match(sourceLauncher, /ensurePackagedWikiRoot/);
  assert.match(sourceLauncher, /WIKI_MANAGED_SOURCE: "1"/);
  assert.match(sourceLauncher, /WIKI_SERVER_DATA_DIR: runtimeRoot/);
});

test("packaging excludes tests and build-only tray scripts", () => {
  const files = packageConfig.build.files;
  for (const pattern of [
    "!dist/src/**/*.test.js",
    "!desktop/**/*.test.cjs",
    "!tray/**/*.test.cjs",
    "!tray/make-icon.cjs",
    "!tray/prepare-wiki-seed.cjs",
  ]) {
    assert.ok(files.includes(pattern), `missing package exclusion: ${pattern}`);
  }
});
