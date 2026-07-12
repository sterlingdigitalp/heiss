/**
 * Heiss.app main process — setup wizard + farm control (real iPhones only).
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const FARM_CLI = path.join(ROOT, "apps/farm/src/cli.ts");

function runFarm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath.includes("Electron")
        ? "npx"
        : "npx",
      ["tsx", FARM_CLI, ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        shell: true,
      },
    );
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
ipcMain.handle("open-external", async (_e, url) => shell.openExternal(url));
