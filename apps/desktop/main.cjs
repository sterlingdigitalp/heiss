/**
 * Heiss.app main process — setup wizard + farm control (real iPhones only).
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");
const { spawn } = require("child_process");
const QRCode = require("qrcode");
const { validateFarmArgs, isTrustedSender } = require("./ipc-guard.cjs");

const ROOT = app.isPackaged ? __dirname : path.resolve(__dirname, "../..");
const FARM_CLI = app.isPackaged
  ? path.join(__dirname, "farm-cli.mjs")
  : path.join(ROOT, "apps/farm/src/cli.ts");
const CANONICAL_DATA = path.join(os.homedir(), ".heiss", "live");
const RENDERER = path.join(__dirname, "renderer.html");

function farmEnvironment(extra = {}) {
  return { ...process.env, HEISS_DATA: CANONICAL_DATA, ...extra };
}

function runFarm(args) {
  return new Promise((resolve, reject) => {
    const child = app.isPackaged
      ? spawn(process.execPath, [FARM_CLI, ...args], {
          cwd: ROOT,
          env: farmEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        })
      : spawn("npx", ["tsx", FARM_CLI, ...args], {
          cwd: ROOT,
          env: farmEnvironment({ ELECTRON_RUN_AS_NODE: undefined }),
        });
    let stdout = "";
    let stderr = "";
    // Without this a missing npx or failed spawn is an unhandled main-process error.
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `exit ${code}`));
        return;
      }
      try {
        // last JSON object in output
        const start = stdout.indexOf("{");
        resolve(start >= 0 ? JSON.parse(stdout.slice(start)) : { ok: true, raw: stdout });
      } catch {
        resolve({ ok: true, raw: stdout });
      }
    });
  });
}

// The controller's launchd agent is installed/removed/inspected through the
// same `heiss-farm daemon` command a person would run by hand (apps/farm/src/
// cli.ts, backed by apps/farm/src/daemon-agent.ts). That installer waits out
// the launchd teardown race, retries loading the agent, and installs the
// watchdog agent too — the desktop app used to duplicate a thinner, racier
// version of this and does so no longer.
function startDaemon() {
  return runFarm(["daemon", "install", "--data", CANONICAL_DATA]);
}

function stopDaemon() {
  return runFarm(["daemon", "uninstall", "--data", CANONICAL_DATA]);
}

function daemonStatus() {
  return runFarm(["daemon", "status", "--data", CANONICAL_DATA]);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: "Heiss",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The window only ever shows the bundled renderer: no navigation, no popups.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(RENDERER);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** Register a handler that only the app's own top-level renderer may call. */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, RENDERER)) throw new Error(`Refused ${channel} from an untrusted frame`);
    return fn(...args);
  });
}

handle("farm", async (args) => runFarm(validateFarmArgs(args)));
handle("daemon-start", async () => startDaemon());
handle("daemon-stop", async () => stopDaemon());
handle("daemon-status", async () => daemonStatus());
handle("qr-code", async (value) => QRCode.toDataURL(String(value).slice(0, 2_000), { width: 220, margin: 1 }));
handle("login-item-get", async () => app.getLoginItemSettings());
handle("login-item-set", async (enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings();
});
// open-external was removed: the renderer never used it, and it passed any
// URL scheme straight to the OS.
