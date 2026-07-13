const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_SEED_ENTRIES = ["AGENTS.md", "index.md", "log.md", "wiki"];
const WIKI_DIRECTORIES = [
  "exports",
  "inbox",
  "raw/assets",
  "raw/sources",
  "tools",
  "wiki/concepts",
  "wiki/decisions",
  "wiki/entities",
  "wiki/maps",
  "wiki/projects",
  "wiki/sources",
];

function ensurePackagedWikiRoot(options) {
  const { contentSeed, dataRoot, gitSeed, wikiRoot } = options;
  const staging = `${wikiRoot}.initializing`;

  if (!fs.existsSync(wikiRoot)) {
    if (!fs.existsSync(contentSeed)) {
      throw new Error(`Packaged wiki seed is missing: ${contentSeed}`);
    }

    fs.mkdirSync(dataRoot, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(contentSeed, staging, { recursive: true });
    ensureWikiDirectories(staging);
    for (const required of REQUIRED_SEED_ENTRIES) {
      if (!fs.existsSync(path.join(staging, required))) {
        throw new Error(`Packaged wiki seed is incomplete: missing ${required}`);
      }
    }
    fs.renameSync(staging, wikiRoot);
  }

  ensureWikiDirectories(wikiRoot);
  ensureWikiGitRepository(wikiRoot, gitSeed);
}

function ensureWikiDirectories(wikiRoot) {
  for (const directory of WIKI_DIRECTORIES) {
    const directoryPath = path.join(wikiRoot, directory);
    const keepPath = path.join(directoryPath, ".gitkeep");
    fs.mkdirSync(directoryPath, { recursive: true });
    if (!fs.existsSync(keepPath)) {
      fs.writeFileSync(keepPath, "");
    }
  }
}

function ensureWikiGitRepository(wikiRoot, gitSeed) {
  const target = path.join(wikiRoot, ".git");
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(gitSeed)) {
    throw new Error(`Packaged wiki Git history is missing: ${gitSeed}`);
  }
  fs.cpSync(gitSeed, target, { recursive: true });
}

module.exports = { ensurePackagedWikiRoot };
