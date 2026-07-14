const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = readFileSync(path.join(__dirname, "index.html"), "utf8");
const css = readFileSync(path.join(__dirname, "styles.css"), "utf8");
const app = readFileSync(path.join(__dirname, "app.js"), "utf8");
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

test("desktop settings expose background launch at Windows login", () => {
  assert.match(html, /id="autoLaunchToggle"/);
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
