const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_WIKI_ENTRIES = ["AGENTS.md", "index.md", "wiki"];
const SENSITIVE_QUERY_KEY = /^(access[_-]?token|auth|key|password|private[_-]?token|signature|token)$/i;

function createGitRemoteService(options) {
  const wikiRoot = path.resolve(options.wikiRoot);
  const runGit = options.runGit || defaultRunGit;
  const runGitSync = options.runGitSync || defaultRunGitSync;
  const onDiagnostic = options.onDiagnostic || (() => {});
  const now = options.now || (() => new Date());
  const sessions = new Map();

  return {
    state: () => getRemoteState(wikiRoot, runGitSync),

    discardImports() {
      for (const session of sessions.values()) {
        fs.rmSync(session.sessionRoot, { recursive: true, force: true });
      }
      sessions.clear();
    },

    async prepareImport(remoteUrl) {
      for (const session of sessions.values()) {
        fs.rmSync(session.sessionRoot, { recursive: true, force: true });
      }
      sessions.clear();
      const safeRemote = validateRemoteUrl(remoteUrl);
      const id = crypto.randomUUID();
      const stagedRoot = path.join(path.dirname(wikiRoot), `.wsi-${id.slice(0, 12)}`);
      const sessionRoot = stagedRoot;
      try {
        await runGit(null, ["-c", "core.longpaths=true", "clone", "--", safeRemote, stagedRoot]);
        await runGit(stagedRoot, ["config", "core.longpaths", "true"]);
      } catch (error) {
        onDiagnostic("clone", error);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
        throw safeGitError("clone");
      }
      try {
        validateWikiStructure(stagedRoot);
      } catch (error) {
        fs.rmSync(sessionRoot, { recursive: true, force: true });
        throw error;
      }
      try {
        const branch = (await runGit(stagedRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        const head = (await runGit(stagedRoot, ["rev-parse", "--short", "HEAD"])).trim();
        const changes = await compareWikiTrees(wikiRoot, stagedRoot);
        const backupPath = makeBackupPath(wikiRoot, now());
        const session = { id, stagedRoot, sessionRoot, branch, head, backupPath };
        sessions.set(id, session);
        return {
          id,
          valid: true,
          remote: redactRemoteUrl(safeRemote),
          branch,
          head,
          requiredEntries: [...REQUIRED_WIKI_ENTRIES],
          backupPath,
          changes,
          trustWarning: "가져온 AGENTS.md가 이 운영 위키의 agent 실행 정책이 됩니다. 신뢰할 수 있는 remote만 가져오세요.",
        };
      } catch (error) {
        onDiagnostic("preview", error);
        fs.rmSync(sessionRoot, { recursive: true, force: true });
        const safeError = new Error("Remote cloned and validated, but the change preview could not be created.");
        safeError.code = "IMPORT_PREVIEW_FAILED";
        throw safeError;
      }
    },

    applyImport(id) {
      const session = sessions.get(id);
      if (!session) throw new Error("Import preview expired. Validate the remote again.");
      validateWikiStructure(session.stagedRoot);
      atomicReplaceWiki({
        wikiRoot,
        stagedRoot: session.stagedRoot,
        backupPath: session.backupPath,
      });
      sessions.delete(id);
      try { fs.rmSync(session.sessionRoot, { recursive: true, force: true }); } catch { /* Staging cleanup is best effort after a successful swap. */ }
      return { imported: true, backupPath: session.backupPath, branch: session.branch, head: session.head };
    },

    async checkPull() {
      const before = await inspectPullState(wikiRoot, runGit, false);
      if (!before.origin) return before;
      try {
        await runGit(wikiRoot, ["fetch", "--no-tags", "origin"]);
      } catch {
        throw safeGitError("fetch");
      }
      return inspectPullState(wikiRoot, runGit, true);
    },

    async fastForwardPull() {
      const state = await this.checkPull();
      if (!state.clean) throw new Error("Pull refused: the operational wiki has local changes.");
      if (state.relation === "diverged") throw new Error("Pull refused: local and remote history have diverged.");
      if (state.relation === "ahead") throw new Error("Pull refused: the local branch is ahead of its remote.");
      if (state.relation !== "behind" || !state.canPull) {
        throw new Error(state.relation === "up-to-date" ? "The operational wiki is already up to date." : "Pull is not safely available.");
      }
      try {
        await runGit(wikiRoot, ["merge", "--ff-only", state.remoteRef]);
      } catch {
        throw safeGitError("fast-forward pull");
      }
      return { pulled: true, ...(await inspectPullState(wikiRoot, runGit, true)) };
    },
  };
}

function validateWikiStructure(root) {
  const missing = [];
  for (const entry of REQUIRED_WIKI_ENTRIES) {
    const target = path.join(root, entry);
    try {
      const stat = fs.lstatSync(target);
      const valid = entry === "wiki" ? stat.isDirectory() && !stat.isSymbolicLink() : stat.isFile();
      if (!valid) missing.push(entry);
    } catch {
      missing.push(entry);
    }
  }
  if (missing.length) {
    const error = new Error(`Remote repository is not an operational wiki. Missing or invalid: ${missing.join(", ")}.`);
    error.code = "INVALID_WIKI";
    throw error;
  }
  return true;
}

function validateRemoteUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error("Enter a valid Git remote URL.");
  }
  const remote = value.trim();
  if (remote.startsWith("-")) throw new Error("Enter a valid Git remote URL.");
  if (/^[^/@\s]+:[^/@\s]+@[^\s]+$/.test(remote)) {
    throw new Error("Do not embed credentials in the remote URL. Use Git Credential Manager or SSH authentication.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let parsed;
    try { parsed = new URL(remote); } catch { throw new Error("Enter a valid Git remote URL."); }
    const httpUser = /^https?:$/i.test(parsed.protocol) && parsed.username;
    if (httpUser || parsed.password || [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
      throw new Error("Do not embed credentials in the remote URL. Use Git Credential Manager or SSH authentication.");
    }
  }
  return remote;
}

function redactRemoteUrl(value) {
  if (!value) return "";
  return String(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?@)/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access[_-]?token|auth|key|password|private[_-]?token|signature|token)=)[^&#\s]*/gi, "$1[REDACTED]");
}

function redactSensitiveText(value) {
  return redactRemoteUrl(String(value))
    .replace(/\b[^\s/@:]+:[^\s/@]+@(?=[^\s]+:[^\s]+)/g, "[REDACTED]@")
    .replace(/(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|password|private[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function safeGitError(operation) {
  const error = new Error(`Git ${operation} failed. Check the remote, network, and system Git/SSH credentials.`);
  error.code = "GIT_REMOTE_FAILED";
  return error;
}

function atomicReplaceWiki({ wikiRoot, stagedRoot, backupPath }) {
  validateWikiStructure(stagedRoot);
  validateWikiStructure(wikiRoot);
  if (fs.existsSync(backupPath)) throw new Error("The planned backup path already exists. Validate the remote again.");
  fs.renameSync(wikiRoot, backupPath);
  try {
    fs.renameSync(stagedRoot, wikiRoot);
  } catch (error) {
    try {
      fs.renameSync(backupPath, wikiRoot);
    } catch {
      throw new Error(`Wiki replacement failed and automatic rollback failed. The preserved wiki is at ${backupPath}.`);
    }
    throw new Error("Wiki replacement failed. The original operational wiki was restored.", { cause: error });
  }
}

function getRemoteState(wikiRoot, runGitSync = defaultRunGitSync) {
  let branch;
  let changes;
  try {
    branch = runGitSync(wikiRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    changes = porcelainLines(runGitSync(wikiRoot, ["status", "--porcelain"]));
  } catch {
    return { available: false, origin: "", branch: "", clean: false, relation: "unavailable", canPull: false };
  }
  let origin;
  try {
    origin = redactRemoteUrl(runGitSync(wikiRoot, ["remote", "get-url", "origin"]).trim());
  } catch {
    return { available: true, origin: "", branch, clean: changes.length === 0, relation: "no-origin", canPull: false };
  }
  let relation = "unchecked";
  let canPull = false;
  try {
    const remoteRef = `refs/remotes/origin/${branch}`;
    const counts = parseAheadBehind(runGitSync(wikiRoot, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`]));
    ({ relation, canPull } = classifyRelation(counts.ahead, counts.behind, changes.length === 0));
  } catch {
    // A fetch is needed before a tracking ref can be compared.
  }
  return { available: true, origin, branch, clean: changes.length === 0, relation, canPull };
}

async function inspectPullState(wikiRoot, runGit, fetched) {
  let branch;
  let clean;
  try {
    branch = (await runGit(wikiRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    clean = porcelainLines(await runGit(wikiRoot, ["status", "--porcelain"])).length === 0;
  } catch {
    return { available: false, origin: "", branch: "", clean: false, relation: "unavailable", canPull: false, fetched };
  }
  let origin;
  try {
    origin = (await runGit(wikiRoot, ["remote", "get-url", "origin"])).trim();
  } catch {
    return { available: true, origin: "", branch, clean, relation: "no-origin", canPull: false, fetched };
  }
  if (!origin) return { available: true, origin: "", branch, clean, relation: "no-origin", canPull: false, fetched };
  if (branch === "HEAD") return { available: true, origin: redactRemoteUrl(origin), branch, clean, relation: "detached", canPull: false, fetched };
  const remoteRef = `refs/remotes/origin/${branch}`;
  let counts;
  try {
    counts = parseAheadBehind(await runGit(wikiRoot, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`]));
  } catch {
    return { available: true, origin: redactRemoteUrl(origin), branch, clean, relation: "missing-remote-branch", canPull: false, fetched, remoteRef };
  }
  const classified = classifyRelation(counts.ahead, counts.behind, clean);
  return { available: true, origin: redactRemoteUrl(origin), branch, clean, ahead: counts.ahead, behind: counts.behind, fetched, remoteRef, ...classified };
}

function classifyRelation(ahead, behind, clean) {
  if (ahead > 0 && behind > 0) return { relation: "diverged", canPull: false };
  if (ahead > 0) return { relation: "ahead", canPull: false };
  if (behind > 0) return { relation: "behind", canPull: clean };
  return { relation: "up-to-date", canPull: false };
}

function parseAheadBehind(output) {
  const [ahead, behind] = String(output).trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error("Invalid Git revision counts");
  return { ahead, behind };
}

function porcelainLines(output) {
  return String(output).split(/\r?\n/).filter(Boolean);
}

function makeBackupPath(wikiRoot, date) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${wikiRoot}.backup-${stamp}`;
}

async function compareWikiTrees(currentRoot, stagedRoot) {
  const [current, staged] = await Promise.all([inventoryTree(currentRoot), inventoryTree(stagedRoot)]);
  const added = [];
  const modified = [];
  const removed = [];
  for (const [name, digest] of staged) {
    if (!current.has(name)) added.push(name);
    else if (current.get(name) !== digest) modified.push(name);
  }
  for (const name of current.keys()) if (!staged.has(name)) removed.push(name);
  for (const values of [added, modified, removed]) values.sort();
  const previewLimit = 80;
  return {
    addedCount: added.length,
    modifiedCount: modified.length,
    removedCount: removed.length,
    paths: [
      ...added.map((name) => `+ ${name}`),
      ...modified.map((name) => `~ ${name}`),
      ...removed.map((name) => `- ${name}`),
    ].slice(0, previewLimit),
    truncated: added.length + modified.length + removed.length > previewLimit,
  };
}

async function inventoryTree(root) {
  const inventory = new Map();
  async function visit(directory, prefix = "") {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!prefix && (entry.name === ".git" || entry.name === ".wiki-server-imports")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isSymbolicLink()) inventory.set(relative, `link:${await fs.promises.readlink(absolute)}`);
      else if (entry.isFile()) inventory.set(relative, await hashFile(absolute));
    }
  }
  await visit(root);
  return inventory;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function defaultRunGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const fullArgs = cwd ? ["-C", cwd, ...args] : args;
    execFile("git", fullArgs, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function defaultRunGitSync(cwd, args) {
  return require("node:child_process").execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
}

module.exports = {
  atomicReplaceWiki,
  createGitRemoteService,
  redactRemoteUrl,
  redactSensitiveText,
  validateRemoteUrl,
  validateWikiStructure,
};
