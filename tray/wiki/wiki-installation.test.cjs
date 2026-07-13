const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensurePackagedWikiRoot } = require("./wiki-installation.cjs");

test("initializes a complete operational wiki and Git seed", (t) => {
  const fixture = makeFixture(t);
  ensurePackagedWikiRoot(fixture);

  assert.equal(fs.readFileSync(path.join(fixture.wikiRoot, "index.md"), "utf8"), "# Index\n");
  assert.equal(fs.readFileSync(path.join(fixture.wikiRoot, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  for (const directory of ["inbox", "raw/sources", "wiki/projects"]) {
    assert.equal(fs.existsSync(path.join(fixture.wikiRoot, directory, ".gitkeep")), true);
  }
});

test("preserves an existing wiki while restoring required structure", (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.wikiRoot, { recursive: true });
  fs.writeFileSync(path.join(fixture.wikiRoot, "index.md"), "user content\n");

  ensurePackagedWikiRoot(fixture);

  assert.equal(fs.readFileSync(path.join(fixture.wikiRoot, "index.md"), "utf8"), "user content\n");
  assert.equal(fs.existsSync(path.join(fixture.wikiRoot, "wiki", "concepts", ".gitkeep")), true);
  assert.equal(fs.existsSync(path.join(fixture.wikiRoot, ".git", "HEAD")), true);
});

test("rejects a missing content seed before creating the wiki", (t) => {
  const fixture = makeFixture(t);
  fs.rmSync(fixture.contentSeed, { recursive: true, force: true });

  assert.throws(() => ensurePackagedWikiRoot(fixture), /wiki seed is missing/);
  assert.equal(fs.existsSync(fixture.wikiRoot), false);
});

function makeFixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-installation-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const contentSeed = path.join(dataRoot, "content-seed");
  const gitSeed = path.join(dataRoot, "git-seed");
  const wikiRoot = path.join(dataRoot, "wiki-root");
  fs.mkdirSync(path.join(contentSeed, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(contentSeed, "AGENTS.md"), "# Contract\n");
  fs.writeFileSync(path.join(contentSeed, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(contentSeed, "log.md"), "# Log\n");
  fs.mkdirSync(gitSeed, { recursive: true });
  fs.writeFileSync(path.join(gitSeed, "HEAD"), "ref: refs/heads/main\n");
  return { contentSeed, dataRoot, gitSeed, wikiRoot };
}
