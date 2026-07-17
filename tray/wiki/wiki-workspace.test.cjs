const assert = require("node:assert/strict");
const test = require("node:test");
const { getObsidianState, getWikiGitState, makeObsidianOpenUri } = require("./wiki-workspace.cjs");

test("reports branch, head, and local wiki changes", () => {
  const output = new Map([
    ["rev-parse --abbrev-ref HEAD", "main\n"],
    ["rev-parse --short HEAD", "abc1234\n"],
    ["rev-list --count HEAD", "42\n"],
    ["status --porcelain", " M index.md\n?? inbox/new.md\n"],
  ]);
  const state = getWikiGitState("C:\\wiki", (_root, args) => output.get(args.join(" ")));
  assert.deepEqual(state, {
    available: true,
    branch: "main",
    head: "abc1234",
    commitCount: 42,
    changeCount: 2,
    clean: false,
    message: "2 local change(s)",
  });
});

test("detects an installed Obsidian and registered operational vault", () => {
  const executable = "C:\\Users\\test\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe";
  const config = "C:\\Users\\test\\AppData\\Roaming\\obsidian\\obsidian.json";
  const state = getObsidianState("C:\\Data\\Wiki Server\\wiki-root", {
    platform: "win32",
    env: {
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
    },
    protocolCommand: `"${executable}" "%1"`,
    exists: (file) => file === executable || file === config,
    readFile: () => JSON.stringify({ vaults: { id: { path: "C:\\Data\\Wiki Server\\wiki-root" } } }),
  });
  assert.equal(state.installed, true);
  assert.equal(state.protocolRegistered, true);
  assert.equal(state.vaultRegistered, true);
  assert.equal(state.executablePath, executable);
});

test("detects Obsidian and its registered vault through Linux XDG paths", () => {
  const executable = "/usr/bin/obsidian";
  const config = "/home/test/.config/obsidian/obsidian.json";
  const state = getObsidianState("/home/test/wiki", {
    platform: "linux",
    env: { XDG_CONFIG_HOME: "/home/test/.config" },
    home: "/home/test",
    exists: (file) => file === executable || file === config,
    readFile: () => JSON.stringify({ vaults: { id: { path: "/home/test/wiki" } } }),
  });
  assert.equal(state.installed, true);
  assert.equal(state.protocolRegistered, true);
  assert.equal(state.vaultRegistered, true);
  assert.equal(state.executablePath, executable);
});

test("builds an encoded Obsidian URI for the wiki index", () => {
  assert.match(makeObsidianOpenUri("C:\\Wiki Root"), /^obsidian:\/\/open\?path=/);
  assert.match(makeObsidianOpenUri("C:\\Wiki Root"), /index\.md/);
  assert.match(makeObsidianOpenUri("C:\\Wiki Root"), /%5C/);
});
