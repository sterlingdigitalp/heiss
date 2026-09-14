/**
 * Heiss.app main process — setup wizard + farm control (real iPhones only).
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const QRCode = require("qrcode");
const { validateFarmArgs, isTrustedSender } = require("./ipc-guard.cjs");

const ROOT = app.isPackaged ? __dirname : path.resolve(__dirname, "../..");
const FARM_CLI = app.isPackaged
  ? path.join(__dirname, "farm-cli.mjs")
  : path.join(ROOT, "apps/farm/src/cli.ts");
const CANONICAL_DATA = path.join(os.homedir(), ".heiss", "live");
const CONTROLLER_LABEL = "so.heiss.controller";
const CONTROLLER_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${CONTROLLER_LABEL}.plist`);
const CONTROLLER_LOG = path.join(CANONICAL_DATA, "controller.log");
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

function controllerProgramArguments() {
  return app.isPackaged
    ? [process.execPath, FARM_CLI, "daemon", "--data", CANONICAL_DATA]
    : ["/usr/bin/env", "npx", "tsx", FARM_CLI, "daemon", "--data", CANONICAL_DATA];
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function startDaemon() {
  fs.mkdirSync(path.dirname(CONTROLLER_PLIST), { recursive: true });
  fs.mkdirSync(CANONICAL_DATA, { recursive: true });
  const argumentsXml = controllerProgramArguments().map((arg) => `<string>${xml(arg)}</string>`).join("");
  const environment = app.isPackaged
    ? `<key>ELECTRON_RUN_AS_NODE</key><string>1</string><key>HEISS_DATA</key><string>${xml(CANONICAL_DATA)}</string>`
    : `<key>HEISS_DATA</key><string>${xml(CANONICAL_DATA)}</string><key>PATH</key><string>${xml(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string>`;
  fs.writeFileSync(CONTROLLER_PLIST, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${CONTROLLER_LABEL}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>EnvironmentVariables</key><dict>${environment}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(CONTROLLER_LOG)}</string><key>StandardErrorPath</key><string>${xml(CONTROLLER_LOG)}</string></dict></plist>`);
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, CONTROLLER_PLIST], { encoding: "utf8" });
  if (loaded.status !== 0) throw new Error(loaded.stderr || `launchctl bootstrap failed (${loaded.status})`);
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  return daemonStatus();
}

function stopDaemon() {
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  fs.rmSync(CONTROLLER_PLIST, { force: true });
  return { ok: true, running: false, log: readControllerLog() };
}

function readControllerLog() {
  // Read only the tail; the log grows without bound and this runs on every status poll.
  const bytes = 12_000;
  let fd;
  try {
    fd = fs.openSync(CONTROLLER_LOG, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function daemonStatus() {
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${CONTROLLER_LABEL}`], { encoding: "utf8" });
  return { ok: true, running: result.status === 0, persistent: fs.existsSync(CONTROLLER_PLIST), dataDir: CANONICAL_DATA, log: readControllerLog() };
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
