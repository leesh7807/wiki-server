const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = readFileSync(path.join(__dirname, "index.html"), "utf8");
const css = readFileSync(path.join(__dirname, "styles.css"), "utf8");
const app = readFileSync(path.join(__dirname, "app.js"), "utf8");
const trayMain = readFileSync(path.join(__dirname, "..", "tray", "main.cjs"), "utf8");
const packageConfig = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

test("desktop renderer owns distinct work, activity, wiki, and settings views", () => {
  for (const view of ["workView", "activityView", "wikiView", "settingsView"]) {
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.doesNotMatch(html, /iframe|\/client/);
});

test("desktop metrics focus on active queue state instead of historical outcomes", () => {
  assert.match(app, /counts\.queued/);
  assert.match(app, /counts\.running/);
  assert.doesNotMatch(app, /counts\.succeeded|counts\.failed/);
});

test("desktop renderer exposes port warnings and the copyable repository guide", () => {
  assert.match(html, /id="portWarning"/);
  assert.match(html, /id="integrationGuide"/);
  assert.match(html, /id="copyGuideButton"/);
  assert.match(app, /desktop\.portWarning/);
  assert.match(app, /api\.copyGuide/);
});

test("wiki view exposes operational paths, Git state, and Obsidian integration", () => {
  for (const id of ["openWikiButton", "openDataButton", "openObsidianButton", "gitHead", "gitState"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /api\.workspace\(\)/);
  assert.match(app, /api\.openObsidian\(\)/);
});

test("wiki view exposes staged Git remote import and guarded fast-forward pull", () => {
  for (const id of [
    "gitRemoteUrl",
    "validateImportButton",
    "importTrustWarning",
    "importBackupPath",
    "importChanges",
    "importConfirmation",
    "applyImportButton",
    "gitOrigin",
    "gitSyncState",
    "checkPullButton",
    "pullButton",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /api\.prepareGitImport/);
  assert.match(app, /api\.applyGitImport/);
  assert.match(app, /state\.pullState\?\.clean && state\.pullState\?\.canPull/);
  assert.match(app, /api\.pullGitFastForward/);
  assert.match(app, /userErrorMessage\(error\)/);
  assert.match(app, /Error invoking remote method/);
  assert.match(app, /운영 위키 필수 구조를 확인할 수 없습니다/);
  assert.match(trayMain, /withWikiServerStopped\(\(\) => gitRemote\.applyImport/);
  assert.match(trayMain, /withWikiServerStopped\(\(\) => gitRemote\.fastForwardPull/);
  assert.match(trayMain, /Another Git remote operation is already running/);
  assert.match(trayMain, /queued \|\| running/);
});

test("wiki Git controls use clear hierarchy and left-aligned operation feedback", () => {
  assert.match(html, /<details class="paper info-card wide-card git-import-card">/);
  assert.match(html, /HTTP API integration/);
  assert.match(css, /grid-template-columns:\s*repeat\(3, 1fr\)/);
  assert.match(css, /\.setting-message\.left-message\s*{\s*text-align:\s*left/);
  assert.match(css, /\.sync-pull-button\.ready/);
  assert.match(app, /checkButton\.disabled = !remote\.available \|\| !remote\.origin/);
});

test("desktop settings expose platform-neutral background launch at login", () => {
  assert.match(html, /id="autoLaunchToggle"/);
  assert.match(html, /<h3>로그인 시 자동 시작<\/h3>/);
  assert.doesNotMatch(html, /Windows 로그인/);
  assert.match(app, /api\.getAutoLaunch\(\)/);
  assert.match(app, /api\.setAutoLaunch\(requested\)/);
});

test("tray settings navigation reuses the dedicated desktop settings view", () => {
  assert.match(app, /api\.onNavigate/);
  assert.doesNotMatch(app, /wikiTray/);
});

test("desktop visual system uses the paper and ink palette", () => {
  assert.match(css, /--paper:\s*#f5f4ed/i);
  assert.match(css, /--blue:\s*#1b365d/i);
  assert.doesNotMatch(css, /box-shadow|linear-gradient|radial-gradient/i);
});

test("install and uninstall preserve user data without a custom prompt", () => {
  assert.equal(packageConfig.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(packageConfig.build.nsis.include, undefined);
});
