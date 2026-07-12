/**
 * Heiss.app main process — setup wizard + farm control (real iPhones only).
 */
const { app, BrowserWindow, ipcMain, shell, Notification } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const QRCode = require("qrcode");

const ROOT = app.isPackaged ? __dirname : path.resolve(__dirname, "../..");
const FARM_CLI = app.isPackaged
  ? path.join(__dirname, "farm-cli.mjs")
  : path.join(ROOT, "apps/farm/src/cli.ts");
let daemonProcess = null;
let daemonLog = "";

function runFarm(args) {
  return new Promise((resolve, reject) => {
    const child = app.isPackaged
      ? spawn(process.execPath, [FARM_CLI, ...args], {
          cwd: ROOT,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        })
      : spawn("npx", ["tsx", FARM_CLI, ...args], {
          cwd: ROOT,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
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

function startDaemon() {
  if (daemonProcess && daemonProcess.exitCode === null) {
    return { ok: true, running: true, pid: daemonProcess.pid, log: daemonLog.slice(-4000) };
  }
  daemonLog = "";
  daemonProcess = app.isPackaged
    ? spawn(process.execPath, [FARM_CLI, "daemon"], {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("npx", ["tsx", FARM_CLI, "daemon"], {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      });
  let lineBuffer = "";
  const collect = (chunk) => { daemonLog = (daemonLog + chunk.toString()).slice(-12000); };
  daemonProcess.stdout.on("data", (chunk) => {
    collect(chunk);
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.posts > 0 && Notification.isSupported()) {
          new Notification({ title: "Heiss farm finished", body: `${event.posts} post${event.posts === 1 ? "" : "s"} published successfully.` }).show();
        } else if (event.interrupted && Notification.isSupported()) {
          new Notification({ title: "Heiss paused a session", body: "A device action failed safely and is scheduled to retry." }).show();
        }
      } catch { /* npm and CLI startup lines are not JSON */ }
    }
  });
  daemonProcess.stderr.on("data", collect);
  daemonProcess.on("close", () => { daemonProcess = null; });
  return { ok: true, running: true, pid: daemonProcess.pid };
}

function stopDaemon() {
  if (daemonProcess && daemonProcess.exitCode === null) daemonProcess.kill("SIGTERM");
  return { ok: true, running: false, log: daemonLog.slice(-4000) };
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
ipcMain.handle("daemon-status", async () => ({
  ok: true,
  running: Boolean(daemonProcess && daemonProcess.exitCode === null),
  pid: daemonProcess?.pid,
  log: daemonLog.slice(-4000),
}));
ipcMain.handle("qr-code", async (_e, value) => QRCode.toDataURL(String(value), { width: 220, margin: 1 }));
ipcMain.handle("login-item-get", async () => app.getLoginItemSettings());
ipcMain.handle("login-item-set", async (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings();
});
ipcMain.handle("open-external", async (_e, url) => shell.openExternal(url));

app.on("before-quit", () => {
  if (daemonProcess && daemonProcess.exitCode === null) daemonProcess.kill("SIGTERM");
});
