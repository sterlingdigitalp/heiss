/**
 * Heiss.app main process — setup wizard + farm control (real iPhones only).
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const QRCode = require("qrcode");

const ROOT = app.isPackaged ? __dirname : path.resolve(__dirname, "../..");
const FARM_CLI = app.isPackaged
  ? path.join(__dirname, "farm-cli.mjs")
  : path.join(ROOT, "apps/farm/src/cli.ts");
const CANONICAL_DATA = path.join(os.homedir(), ".heiss", "live");
const CONTROLLER_LABEL = "so.heiss.controller";
const CONTROLLER_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${CONTROLLER_LABEL}.plist`);
const CONTROLLER_LOG = path.join(CANONICAL_DATA, "controller.log");

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
  try { return fs.readFileSync(CONTROLLER_LOG, "utf8").slice(-12000); } catch { return ""; }
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
  win.loadFile(path.join(__dirname, "renderer.html"));
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

ipcMain.handle("farm", async (_e, args) => runFarm(args));
ipcMain.handle("daemon-start", async () => startDaemon());
ipcMain.handle("daemon-stop", async () => stopDaemon());
ipcMain.handle("daemon-status", async () => daemonStatus());
ipcMain.handle("qr-code", async (_e, value) => QRCode.toDataURL(String(value), { width: 220, margin: 1 }));
ipcMain.handle("login-item-get", async () => app.getLoginItemSettings());
ipcMain.handle("login-item-set", async (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings();
});
ipcMain.handle("open-external", async (_e, url) => shell.openExternal(url));
