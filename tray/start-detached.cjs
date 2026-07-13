const { spawn } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const packageRoot = path.resolve(__dirname, "..");
const mainPath = path.join(packageRoot, "tray", "main.cjs");

const child = spawn(electronPath, [mainPath, "--hidden"], {
  cwd: packageRoot,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});

child.unref();
console.log(`Wiki Server tray started in background. pid=${child.pid}`);
