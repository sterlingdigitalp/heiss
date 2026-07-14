/**
 * Controller daemon as a launchd LaunchAgent, managed from the CLI so
 * autonomous operation does not depend on the Heiss.app desktop shell.
 * Shares the label with Heiss.app's installer — whichever writes last wins.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONTROLLER_LABEL = "so.heiss.controller";

export function controllerPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${CONTROLLER_LABEL}.plist`);
}

export function controllerLogPath(dataDir: string): string {
  return join(dataDir, "controller.log");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** LaunchAgent plist for the KeepAlive controller daemon. */
export function controllerPlistXml(opts: {
  programArguments: string[];
  dataDir: string;
  logPath: string;
  environment?: Record<string, string>;
}): string {
  const argsXml = opts.programArguments.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("");
  const env = { HEISS_DATA: opts.dataDir, ...(opts.environment ?? {}) };
  const envXml = Object.entries(env)
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${CONTROLLER_LABEL}</string><key>ProgramArguments</key><array>${argsXml}</array><key>EnvironmentVariables</key><dict>${envXml}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xmlEscape(opts.logPath)}</string><key>StandardErrorPath</key><string>${xmlEscape(opts.logPath)}</string></dict></plist>`;
}

/**
 * A node path that stays valid across version upgrades: prefer a stable
 * symlink (e.g. /opt/homebrew/bin/node) over the versioned Cellar binary
 * process.execPath resolves to.
 */
export function stableNodePath(execPath = process.execPath): string {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (existsSync(candidate) && realpathSync(candidate) === realpathSync(execPath)) {
        return candidate;
      }
    } catch {
      /* candidate unusable */
    }
  }
  return execPath;
}

/**
 * Program arguments for the daemon. Prefers the built dist/cli.js run by the
 * current node binary; falls back to npx tsx over the TypeScript source.
 */
export function controllerProgramArguments(opts: {
  dataDir: string;
  distCliPath: string;
  srcCliPath: string;
  intervalSec?: number;
}): string[] {
  const interval = opts.intervalSec ? ["--interval-sec", String(opts.intervalSec)] : [];
  if (existsSync(opts.distCliPath)) {
    return [stableNodePath(), opts.distCliPath, "daemon", "--data", opts.dataDir, ...interval];
  }
  return ["/usr/bin/env", "npx", "tsx", opts.srcCliPath, "daemon", "--data", opts.dataDir, ...interval];
}

export interface ControllerAgentStatus {
  ok: boolean;
  running: boolean;
  persistent: boolean;
  plist: string;
  dataDir?: string;
  log?: string;
}

export function controllerAgentStatus(dataDir?: string): ControllerAgentStatus {
  const uid = process.getuid?.() ?? 0;
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${CONTROLLER_LABEL}`], { encoding: "utf8" });
  let log: string | undefined;
  if (dataDir) {
    try {
      log = readFileSync(controllerLogPath(dataDir), "utf8").slice(-4000);
    } catch {
      log = undefined;
    }
  }
  return {
    ok: true,
    running: result.status === 0,
    persistent: existsSync(controllerPlistPath()),
    plist: controllerPlistPath(),
    dataDir,
    log,
  };
}

export function installControllerAgent(opts: {
  dataDir: string;
  distCliPath: string;
  srcCliPath: string;
  intervalSec?: number;
  environment?: Record<string, string>;
}): ControllerAgentStatus {
  const uid = process.getuid?.() ?? 0;
  const plistPath = controllerPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(opts.dataDir, { recursive: true });
  const programArguments = controllerProgramArguments(opts);
  const environment: Record<string, string> = { ...(opts.environment ?? {}) };
  // The tsx fallback needs a PATH that can resolve npx/node.
  if (programArguments[0] === "/usr/bin/env") {
    environment.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  }
  writeFileSync(
    plistPath,
    controllerPlistXml({
      programArguments,
      dataDir: opts.dataDir,
      logPath: controllerLogPath(opts.dataDir),
      environment,
    }),
  );
  spawnSync("launchctl", ["bootout", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  // bootout returns before launchd finishes removing the job; bootstrapping
  // the same label during teardown fails with EIO. Wait until it is gone.
  for (let attempt = 0; attempt < 100; attempt++) {
    const gone = spawnSync("launchctl", ["print", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
    if (gone.status !== 0) break;
    spawnSync("/bin/sleep", ["0.1"]);
  }
  let loaded = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  if (loaded.status !== 0) {
    // One bounded retry for the same teardown race launchd occasionally
    // reports even after the label stops printing.
    spawnSync("/bin/sleep", ["2"]);
    loaded = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  }
  if (loaded.status !== 0) {
    throw new Error(loaded.stderr || `launchctl bootstrap failed (${loaded.status})`);
  }
  spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  return controllerAgentStatus(opts.dataDir);
}

export function uninstallControllerAgent(dataDir?: string): ControllerAgentStatus {
  const uid = process.getuid?.() ?? 0;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  rmSync(controllerPlistPath(), { force: true });
  return controllerAgentStatus(dataDir);
}
