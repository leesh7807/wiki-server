const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createAutoLaunch } = require("./auto-launch.cjs");
const { makeIntegrationGuide } = require("./integration-guide.cjs");
const { parseAppPort, selectServerPort } = require("./port-selection.cjs");

const packageRoot = path.resolve(__dirname, "..");
const packagedDataRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Wiki Server",
);
if (app.isPackaged) {
  app.setPath("userData", packagedDataRoot);
}
const managedWikiRoot = app.isPackaged
  ? path.join(packagedDataRoot, "wiki-root")
  : undefined;
const configuredWikiRoot = process.env.WIKI_ROOT
  ? path.resolve(process.env.WIKI_ROOT)
  : managedWikiRoot;
const dataDir = process.env.WIKI_SERVER_DATA_DIR
  ? path.resolve(process.env.WIKI_SERVER_DATA_DIR)
  : app.isPackaged
    ? path.join(packagedDataRoot, "runtime")
    : path.join(packageRoot, ".cache", "wiki-server");
const host = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = 55173;
const requestedPort = parseAppPort(process.env.PORT) ?? DEFAULT_PORT;
let port = requestedPort;
let portWarning = "";
let serverUrl = "";
let clientUrl = "";
let healthUrl = "";
updateServerUrls();
const logDir = dataDir;
const logPath = path.join(logDir, "tray.log");
const parsedMaxLogBytes = Number.parseInt(process.env.TRAY_LOG_MAX_BYTES || "", 10);
const parsedMaxLogFiles = Number.parseInt(process.env.TRAY_LOG_MAX_FILES || "", 10);
const maxLogBytes = Number.isFinite(parsedMaxLogBytes) && parsedMaxLogBytes > 0
  ? parsedMaxLogBytes
  : 5 * 1024 * 1024;
const maxLogFiles = Number.isFinite(parsedMaxLogFiles) && parsedMaxLogFiles > 1
  ? parsedMaxLogFiles
  : 3;
const trayMainPath = path.join(packageRoot, "tray", "main.cjs");
const tsxCliPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const serverEntryPath = app.isPackaged
  ? path.join(packageRoot, "dist", "src", "server.js")
  : path.join(packageRoot, "src", "server.ts");
const serverArgs = app.isPackaged
  ? [serverEntryPath]
  : [tsxCliPath, serverEntryPath];
const serverProcessCwd = app.isPackaged ? configuredWikiRoot : packageRoot;
const defaultCodexBin = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe")
  : "codex";
const iconPath = path.join(packageRoot, "tray", "icon.ico");
const fallbackIconPath = path.join(packageRoot, "tray", "icon.svg");
const autoLaunch = createAutoLaunch({
  app,
  name: "local.wiki-server",
  platform: process.platform,
  executablePath: process.execPath,
  args: app.isPackaged ? ["--hidden"] : [trayMainPath, "--hidden"],
});
const startHidden = process.argv.includes("--hidden");

let tray;
let mainWindow = null;
let settingsWindow = null;
let serverProcess = null;
let status = "starting";
let externallyManaged = false;
let quitting = false;

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  app.setName("Wiki Server");
  app.setAppUserModelId("local.wiki-server");
  const portSelection = await selectServerPort(host, requestedPort, DEFAULT_PORT);
  port = portSelection.port;
  portWarning = portSelection.warning;
  updateServerUrls();
  ensurePackagedWikiRoot();
  fs.mkdirSync(logDir, { recursive: true });
  registerSettingsHandlers();
  registerDesktopHandlers();

  tray = new Tray(createTrayIcon());
  tray.setToolTip("Wiki Server");
  tray.on("click", showMainWindow);
  updateMenu();

  await startServer();
  pollHealth();
  if (!startHidden) {
    await waitUntilHealthy(10_000);
    showMainWindow();
  }
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});

async function startServer() {
  if (serverProcess) {
    return;
  }

  status = "checking";
  updateMenu();

  if (await isHealthy()) {
    externallyManaged = true;
    status = "running";
    updateMenu();
    return;
  }

  externallyManaged = false;
  status = "starting";
  updateMenu();
  appendLog(`\n[tray] starting server at ${new Date().toISOString()}\n`);

  serverProcess = spawn(process.execPath, serverArgs, {
    cwd: serverProcessCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(configuredWikiRoot ? { WIKI_ROOT: configuredWikiRoot } : {}),
      WIKI_SERVER_DATA_DIR: dataDir,
      HOST: host,
      PORT: port,
      CODEX_BIN: process.env.CODEX_BIN || defaultCodexBin,
    },
    windowsHide: true,
  });

  serverProcess.stdout.on("data", (chunk) => appendLog(chunk));
  serverProcess.stderr.on("data", (chunk) => appendLog(chunk));

  serverProcess.on("error", (error) => {
    appendLog(`[tray] failed to start server: ${error.stack || error.message}\n`);
    status = "failed";
    serverProcess = null;
    updateMenu();
    notify("Wiki Server failed to start", error.message);
  });

  serverProcess.on("exit", (code, signal) => {
    appendLog(`[tray] server exited code=${code} signal=${signal}\n`);
    serverProcess = null;
    if (!quitting) {
      status = code === 0 ? "stopped" : "failed";
      updateMenu();
    }
  });
}

function stopServer() {
  if (!serverProcess || externallyManaged) {
    return;
  }

  const pid = serverProcess.pid;
  appendLog(`[tray] stopping server pid=${pid}\n`);

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    serverProcess.kill("SIGTERM");
  }

  serverProcess = null;
  status = "stopped";
  updateMenu();
}

async function restartServer() {
  stopServer();
  externallyManaged = false;
  await delay(600);
  await startServer();
}

function pollHealth() {
  setInterval(async () => {
    if (!serverProcess && !externallyManaged) {
      return;
    }

    const healthy = await isHealthy();
    if (serverProcess) {
      status = healthy ? "running" : "starting";
    } else if (externallyManaged && healthy) {
      status = "running";
    } else {
      externallyManaged = false;
      status = "stopped";
    }
    updateMenu();
  }, 5000);
}

function updateMenu() {
  if (!tray) {
    return;
  }

  const statusLabel = externallyManaged && status === "running"
    ? "Status: running (external)"
    : `Status: ${status}`;
  const autoLaunchState = getAutoLaunchState();

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Open Wiki Server", click: showMainWindow },
    { label: "Open health check", click: openServer },
    { label: "Settings", click: openSettings },
    { label: "Open logs", click: () => shell.openPath(logPath) },
    { type: "separator" },
    {
      label: autoLaunchState.supported ? "Launch at login" : "Launch at login (unsupported)",
      type: "checkbox",
      checked: autoLaunchState.enabled,
      enabled: autoLaunchState.supported,
      click: (menuItem) => setAutoLaunch(menuItem.checked),
    },
    { type: "separator" },
    { label: "Start server", enabled: !serverProcess && !externallyManaged, click: startServer },
    { label: "Restart server", enabled: !!serverProcess || externallyManaged, click: restartServer },
    { label: "Stop server", enabled: !!serverProcess && !externallyManaged, click: stopServer },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function openServer() {
  shell.openExternal(healthUrl);
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 380,
    height: 340,
    resizable: false,
    title: "Wiki Server Settings",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsHtml())}`);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function registerSettingsHandlers() {
  ipcMain.handle("settings:get", () => ({
    autoLaunch: getAutoLaunchState().enabled,
    autoLaunchState: getAutoLaunchState(),
    clientUrl,
    externallyManaged,
    healthUrl,
    logPath,
    status,
    wikiRoot: configuredWikiRoot || "automatic (embedded wiki-root preferred)",
    dataDir,
  }));

  ipcMain.handle("settings:set-auto-launch", (_event, enabled) => {
    const state = setAutoLaunch(Boolean(enabled));
    return { autoLaunch: state.enabled, autoLaunchState: state };
  });

  ipcMain.handle("settings:open-client", () => openClient());
  ipcMain.handle("settings:open-health", () => openServer());
  ipcMain.handle("settings:open-logs", () => shell.openPath(logPath));
  ipcMain.handle("settings:open-data", () => shell.openPath(app.isPackaged ? packagedDataRoot : dataDir));
}

function registerDesktopHandlers() {
  ipcMain.handle("desktop:health", async () => ({
    ...(await requestApi("GET", "/health")),
    desktop: {
      baseUrl: serverUrl,
      defaultPort: DEFAULT_PORT,
      port,
      portWarning,
      integrationGuide: makeIntegrationGuide(serverUrl),
    },
  }));
  ipcMain.handle("desktop:metrics", () => requestApi("GET", "/metrics/jobs"));
  ipcMain.handle("desktop:job", (_event, id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error("Invalid job id");
    }
    return requestApi("GET", `/jobs/${encodeURIComponent(id)}`);
  });
  ipcMain.handle("desktop:submit", (_event, input) => {
    const command = input?.command;
    if (!new Set(["query", "ingest", "lint"]).has(command)) {
      throw new Error("Invalid command");
    }
    const content = typeof input?.content === "string" ? input.content : "";
    if (command !== "lint" && content.trim().length === 0) {
      throw new Error("Query and ingest require content");
    }
    return requestApi("POST", `/${command}`, command === "lint" ? {} : { content });
  });
  ipcMain.handle("desktop:cancel", (_event, id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error("Invalid job id");
    }
    return requestApi("POST", `/jobs/${encodeURIComponent(id)}/cancel`);
  });
  ipcMain.handle("desktop:open-data", () =>
    shell.openPath(app.isPackaged ? packagedDataRoot : dataDir));
  ipcMain.handle("desktop:open-logs", () => shell.openPath(logPath));
  ipcMain.handle("desktop:open-web-client", () => shell.openExternal(clientUrl));
  ipcMain.handle("desktop:copy-guide", () => {
    clipboard.writeText(makeIntegrationGuide(serverUrl));
    return true;
  });
  ipcMain.handle("desktop:get-auto-launch", () => getAutoLaunchState());
  ipcMain.handle("desktop:set-auto-launch", (_event, enabled) =>
    setAutoLaunch(Boolean(enabled)));
}

function getAutoLaunchState() {
  return autoLaunch.getState();
}

function setAutoLaunch(enabled) {
  const state = autoLaunch.setEnabled(enabled);
  updateMenu();
  return state;
}

function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    title: "Wiki Server",
    icon: iconPath,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "desktop-preload.cjs"),
    },
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadFile(path.join(packageRoot, "desktop", "index.html"));
}

function openClient() {
  showMainWindow();
}

function ensurePackagedWikiRoot() {
  if (!app.isPackaged || process.env.WIKI_ROOT) return;

  const seed = path.join(process.resourcesPath, "wiki-root-seed");
  const staging = path.join(packagedDataRoot, "wiki-root.initializing");
  if (!fs.existsSync(managedWikiRoot)) {
    if (!fs.existsSync(seed)) {
      throw new Error(`Packaged wiki seed is missing: ${seed}`);
    }

    fs.mkdirSync(packagedDataRoot, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(seed, staging, { recursive: true });
    ensureWikiDirectories(staging);
    for (const required of ["AGENTS.md", "index.md", "log.md", "wiki"]) {
      if (!fs.existsSync(path.join(staging, required))) {
        throw new Error(`Packaged wiki seed is incomplete: missing ${required}`);
      }
    }
    fs.renameSync(staging, managedWikiRoot);
  }

  ensureWikiDirectories(managedWikiRoot);
  ensurePackagedWikiGitRepository();
}

function ensureWikiDirectories(wikiRoot) {
  for (const directory of [
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
  ]) {
    const directoryPath = path.join(wikiRoot, directory);
    const keepPath = path.join(directoryPath, ".gitkeep");
    fs.mkdirSync(directoryPath, { recursive: true });
    if (!fs.existsSync(keepPath)) {
      fs.writeFileSync(keepPath, "");
    }
  }
}

function ensurePackagedWikiGitRepository() {
  const target = path.join(managedWikiRoot, ".git");
  if (fs.existsSync(target)) return;

  const gitSeed = path.join(process.resourcesPath, "wiki-git-seed");
  if (!fs.existsSync(gitSeed)) {
    throw new Error(`Packaged wiki Git history is missing: ${gitSeed}`);
  }
  fs.cpSync(gitSeed, target, { recursive: true });
}

function appendLog(chunk) {
  rotateLogIfNeeded(Buffer.byteLength(chunk));
  fs.appendFile(logPath, chunk, () => {});
}

function rotateLogIfNeeded(incomingBytes) {
  try {
    const currentBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    if (currentBytes + incomingBytes <= maxLogBytes) {
      return;
    }

    for (let index = maxLogFiles - 1; index >= 1; index -= 1) {
      const current = rotatedLogPath(index);
      const next = rotatedLogPath(index + 1);
      if (!fs.existsSync(current)) continue;

      if (index + 1 >= maxLogFiles) {
        fs.rmSync(current, { force: true });
      } else {
        fs.renameSync(current, next);
      }
    }

    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, rotatedLogPath(1));
    }
  } catch {
    // Logging must never keep the tray process from managing the server.
  }
}

function rotatedLogPath(index) {
  return path.join(logDir, `tray.${index}.log`);
}

function isHealthy() {
  return new Promise((resolve) => {
    const request = http.get(healthUrl, { timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function requestApi(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      hostname: host,
      port,
      path: requestPath,
      method,
      timeout: 10_000,
      headers: encodedBody
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(encodedBody),
          }
        : undefined,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`Wiki Server returned invalid JSON (${response.statusCode})`));
          return;
        }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(payload.error || `Wiki Server request failed (${response.statusCode})`));
          return;
        }
        resolve(payload);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Wiki Server request timed out")));
    request.on("error", reject);
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
}

function updateServerUrls() {
  serverUrl = `http://${host}:${port}`;
  clientUrl = `${serverUrl}/client`;
  healthUrl = `${serverUrl}/health`;
}


async function waitUntilHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await delay(250);
  }
  return false;
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTrayIcon() {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return nativeImage.createFromPath(fallbackIconPath).resize({ width: 16, height: 16 });
  }
  return image.resize({ width: 16, height: 16 });
}

function settingsHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wiki Server Settings</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", sans-serif; }
    body { margin: 0; padding: 18px; }
    h1 { font-size: 18px; margin: 0 0 14px; font-weight: 600; }
    .row { display: flex; align-items: center; gap: 10px; margin: 14px 0; }
    .meta { margin: 12px 0 18px; color: #64748b; font-size: 12px; line-height: 1.45; word-break: break-all; }
    button { border: 1px solid #94a3b8; border-radius: 6px; background: transparent; padding: 7px 10px; font: inherit; cursor: pointer; }
    button:hover { background: rgba(148, 163, 184, 0.16); }
    input { width: 16px; height: 16px; }
    #saved { color: #16a34a; font-size: 12px; min-height: 18px; }
    #autoLaunchNote { color: #64748b; font-size: 12px; margin-top: -6px; }
  </style>
</head>
<body>
  <h1>Wiki Server</h1>
  <label class="row">
    <input id="autoLaunch" type="checkbox">
    <span>Launch when the computer starts</span>
  </label>
  <div id="autoLaunchNote"></div>
  <div class="meta">
    <div>Status: <span id="status">loading</span></div>
    <div>Client: <span id="client"></span></div>
    <div>Health: <span id="health"></span></div>
    <div>Wiki root: <span id="wikiRoot"></span></div>
    <div>Data: <span id="dataDir"></span></div>
  </div>
  <div class="row">
    <button id="openClient">Open client</button>
    <button id="openHealth">Open health check</button>
    <button id="openLogs">Open logs</button>
    <button id="openData">Open data</button>
  </div>
  <div id="saved"></div>
  <script>
    const autoLaunch = document.getElementById("autoLaunch");
    const saved = document.getElementById("saved");

    async function render() {
      const settings = await window.wikiTray.getSettings();
      autoLaunch.checked = settings.autoLaunch;
      autoLaunch.disabled = !settings.autoLaunchState.supported;
      document.getElementById("autoLaunchNote").textContent = settings.autoLaunchState.message || "";
      document.getElementById("status").textContent = settings.externallyManaged
        ? settings.status + " (external)"
        : settings.status;
      document.getElementById("client").textContent = settings.clientUrl;
      document.getElementById("health").textContent = settings.healthUrl;
      document.getElementById("wikiRoot").textContent = settings.wikiRoot;
      document.getElementById("dataDir").textContent = settings.dataDir;
    }

    autoLaunch.addEventListener("change", async () => {
      const result = await window.wikiTray.setAutoLaunch(autoLaunch.checked);
      autoLaunch.checked = result.autoLaunch;
      autoLaunch.disabled = !result.autoLaunchState.supported;
      document.getElementById("autoLaunchNote").textContent = result.autoLaunchState.message || "";
      saved.textContent = "Saved";
      setTimeout(() => saved.textContent = "", 1400);
    });

    document.getElementById("openClient").addEventListener("click", () => window.wikiTray.openClient());
    document.getElementById("openHealth").addEventListener("click", () => window.wikiTray.openHealth());
    document.getElementById("openLogs").addEventListener("click", () => window.wikiTray.openLogs());
    document.getElementById("openData").addEventListener("click", () => window.wikiTray.openData());
    render();
  </script>
</body>
</html>`;
}
