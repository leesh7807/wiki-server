const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageRoot = path.resolve(__dirname, "..");
const packageConfig = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const gitignore = readFileSync(path.join(packageRoot, ".gitignore"), "utf8");
const main = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("server and nested wiki use independent Git boundaries", () => {
  assert.match(gitignore, /^\/wiki-root\/$/m);
  assert.match(main, /wiki-git-seed/);
  assert.match(main, /ensurePackagedWikiGitRepository/);
});

test("packaging carries wiki content and renamed Git history separately", () => {
  const resources = packageConfig.build.extraResources;
  assert.ok(resources.some((entry) => entry.to === "wiki-root-seed"));
  assert.ok(resources.some((entry) => entry.to === "wiki-git-seed"));
  const contentSeed = resources.find((entry) => entry.to === "wiki-root-seed");
  assert.ok(contentSeed.filter.some((pattern) => pattern.includes(".git/**")));
});
