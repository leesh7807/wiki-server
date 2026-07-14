const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createGitRemoteService,
  redactSensitiveText,
  validateRemoteUrl,
} = require("./git-remote.cjs");

test("clones a valid generic remote into staging and validates the wiki structure", async (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = makeCurrentWiki(fixture.root);
  const service = createGitRemoteService({ wikiRoot, now: () => new Date("2026-07-14T10:20:30.000Z") });

  const preview = await service.prepareImport(fixture.remote);

  assert.equal(preview.valid, true);
  assert.equal(preview.branch, "main");
  assert.deepEqual(preview.requiredEntries, ["AGENTS.md", "index.md", "wiki"]);
  assert.match(preview.backupPath, /wiki-root\.backup-2026-07-14T10-20-30-000Z$/);
  assert.ok(preview.changes.modifiedCount >= 1);
});

test("checks out deep Windows paths with repository-local long-path support", async (t) => {
  const fixture = makeRemoteFixture(t, { deepPath: true });
  const wikiRoot = makeCurrentWiki(fixture.root);
  const service = createGitRemoteService({ wikiRoot });

  const preview = await service.prepareImport(fixture.remote);

  assert.equal(preview.valid, true);
  const stagedConfig = git(path.join(path.dirname(wikiRoot), `.wsi-${preview.id.slice(0, 12)}`), ["config", "--get", "core.longpaths"]).trim();
  assert.equal(stagedConfig, "true");
  service.discardImports();
});

test("rejects a cloned repository missing required wiki entries", async (t) => {
  const fixture = makeRemoteFixture(t, { valid: false });
  const wikiRoot = makeCurrentWiki(fixture.root);
  const service = createGitRemoteService({ wikiRoot });

  await assert.rejects(service.prepareImport(fixture.remote), /Missing or invalid: AGENTS\.md, index\.md, wiki/);
  assert.equal(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8"), "# Current\n");
});

test("backs up the existing wiki and atomically installs the staged clone", async (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = makeCurrentWiki(fixture.root);
  const service = createGitRemoteService({ wikiRoot, now: () => new Date("2026-07-14T10:20:30.000Z") });
  const preview = await service.prepareImport(fixture.remote);

  const result = service.applyImport(preview.id);

  assert.equal(normalizeNewlines(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8")), "# Remote\n");
  assert.equal(fs.readFileSync(path.join(result.backupPath, "index.md"), "utf8"), "# Current\n");
  assert.equal(fs.existsSync(path.join(result.backupPath, ".git")), true);
});

test("preserves the existing wiki when clone fails", async (t) => {
  const root = makeRoot(t);
  const wikiRoot = makeCurrentWiki(root);
  const service = createGitRemoteService({ wikiRoot });

  await assert.rejects(service.prepareImport(path.join(root, "missing.git")), /Git clone failed/);

  assert.equal(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8"), "# Current\n");
  assert.equal(fs.existsSync(path.join(wikiRoot, ".git")), true);
});

test("refuses pull when the operational worktree is dirty", async (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = path.join(fixture.root, "wiki-root");
  git(null, ["clone", fixture.remote, wikiRoot]);
  fs.writeFileSync(path.join(wikiRoot, "index.md"), "local edit\n");
  const service = createGitRemoteService({ wikiRoot });

  await assert.rejects(service.fastForwardPull(), /local changes/);
  assert.equal(fs.readFileSync(path.join(wikiRoot, "index.md"), "utf8"), "local edit\n");
});

test("refuses pull when local and remote histories diverge", async (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = path.join(fixture.root, "wiki-root");
  git(null, ["clone", fixture.remote, wikiRoot]);
  configureAuthor(wikiRoot);
  fs.writeFileSync(path.join(wikiRoot, "local.md"), "local\n");
  git(wikiRoot, ["add", "."]);
  git(wikiRoot, ["commit", "-m", "local"]);
  pushRemoteUpdate(fixture, "remote.md", "remote\n");
  const service = createGitRemoteService({ wikiRoot });

  await assert.rejects(service.fastForwardPull(), /history ha(?:s|ve) diverged/);
  assert.equal(fs.existsSync(path.join(wikiRoot, "remote.md")), false);
});

test("pulls successfully only as a clean fast-forward", async (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = path.join(fixture.root, "wiki-root");
  git(null, ["clone", fixture.remote, wikiRoot]);
  pushRemoteUpdate(fixture, "wiki/new.md", "new page\n");
  const service = createGitRemoteService({ wikiRoot });

  const checked = await service.checkPull();
  assert.equal(checked.relation, "behind");
  assert.equal(checked.canPull, true);
  const result = await service.fastForwardPull();

  assert.equal(result.relation, "up-to-date");
  assert.equal(normalizeNewlines(fs.readFileSync(path.join(wikiRoot, "wiki", "new.md"), "utf8")), "new page\n");
});

test("reports the current origin, branch, cleanliness, and sync relation without fetching", (t) => {
  const fixture = makeRemoteFixture(t);
  const wikiRoot = path.join(fixture.root, "wiki-root");
  git(null, ["clone", fixture.remote, wikiRoot]);
  const service = createGitRemoteService({ wikiRoot });

  const state = service.state();

  assert.equal(state.available, true);
  assert.equal(state.origin, fixture.remote);
  assert.equal(state.branch, "main");
  assert.equal(state.clean, true);
  assert.equal(state.relation, "up-to-date");
});

test("reports a clean repository without origin as no-origin instead of dirty", async (t) => {
  const root = makeRoot(t);
  const wikiRoot = makeCurrentWiki(root);
  const service = createGitRemoteService({ wikiRoot });

  assert.deepEqual(service.state(), {
    available: true,
    origin: "",
    branch: "main",
    clean: true,
    relation: "no-origin",
    canPull: false,
  });
  const checked = await service.checkPull();
  assert.equal(checked.relation, "no-origin");
  assert.equal(checked.clean, true);
});

test("delegates authentication by rejecting embedded secrets and redacts logs", () => {
  assert.equal(validateRemoteUrl("https://gitlab.example/team/wiki.git"), "https://gitlab.example/team/wiki.git");
  assert.equal(validateRemoteUrl("git@git.example:team/wiki.git"), "git@git.example:team/wiki.git");
  assert.throws(() => validateRemoteUrl("https://oauth2:super-secret@gitlab.example/team/wiki.git"), /Credential Manager or SSH/);
  assert.throws(() => validateRemoteUrl("https://git.example/wiki.git?access_token=super-secret"), /Credential Manager or SSH/);
  assert.throws(() => validateRemoteUrl("ssh://git:super-secret@git.example/team/wiki.git"), /Credential Manager or SSH/);
  assert.throws(() => validateRemoteUrl("git:super-secret@git.example:team/wiki.git"), /Credential Manager or SSH/);

  const safe = redactSensitiveText("clone https://oauth2:super-secret@git.example/wiki.git?token=also-secret git:scp-secret@git.example:team/wiki.git Authorization: Bearer abc123 password=hunter2");
  assert.doesNotMatch(safe, /super-secret|also-secret|scp-secret|abc123|hunter2/);
  assert.match(safe, /\[REDACTED\]/);
});

function makeRemoteFixture(t, options = {}) {
  const root = makeRoot(t);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(source, { recursive: true });
  git(source, ["init", "-b", "main"]);
  configureAuthor(source);
  if (options.valid !== false) {
    fs.mkdirSync(path.join(source, "wiki"), { recursive: true });
    fs.writeFileSync(path.join(source, "AGENTS.md"), "# Remote policy\n");
    fs.writeFileSync(path.join(source, "index.md"), "# Remote\n");
    fs.writeFileSync(path.join(source, "wiki", "page.md"), "remote page\n");
    if (options.deepPath) {
      git(source, ["config", "core.longpaths", "true"]);
      const deep = path.join(source, "wiki", "a".repeat(72), "b".repeat(72), "c".repeat(72));
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, "deep-page.md"), "deep page\n");
    }
  } else {
    fs.writeFileSync(path.join(source, "README.md"), "not a wiki\n");
  }
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "initial"]);
  git(null, ["clone", "--bare", source, remote]);
  return { root, source, remote };
}

function makeCurrentWiki(root) {
  const wikiRoot = path.join(root, "wiki-root");
  fs.mkdirSync(path.join(wikiRoot, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(wikiRoot, "AGENTS.md"), "# Current policy\n");
  fs.writeFileSync(path.join(wikiRoot, "index.md"), "# Current\n");
  fs.writeFileSync(path.join(wikiRoot, "wiki", "old.md"), "old page\n");
  git(wikiRoot, ["init", "-b", "main"]);
  configureAuthor(wikiRoot);
  git(wikiRoot, ["add", "."]);
  git(wikiRoot, ["commit", "-m", "current"]);
  return wikiRoot;
}

function pushRemoteUpdate(fixture, relativePath, content) {
  const updater = path.join(fixture.root, `updater-${path.basename(relativePath).replace(/\W/g, "-")}`);
  git(null, ["clone", fixture.remote, updater]);
  configureAuthor(updater);
  const target = path.join(updater, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  git(updater, ["add", "."]);
  git(updater, ["commit", "-m", "remote update"]);
  git(updater, ["push", "origin", "main"]);
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-git-remote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function configureAuthor(root) {
  git(root, ["config", "user.name", "Wiki Test"]);
  git(root, ["config", "user.email", "wiki@example.invalid"]);
}

function git(cwd, args) {
  return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n");
}
