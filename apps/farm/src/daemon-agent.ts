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

export const WATCHDOG_LABEL = "so.heiss.watchdog";
/** Single-shot check; launchd reruns it, so a crash costs one interval. */
export const WATCHDOG_INTERVAL_SEC = 300;

export function watchdogPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${WATCHDOG_LABEL}.plist`);
}

export function watchdogLogPath(dataDir: string): string {
  return join(dataDir, "watchdog.log");
}

export function watchdogPlistXml(opts: {
  programArguments: string[];
  logPath: string;
  intervalSec?: number;
  environment?: Record<string, string>;
}): string {
  const argsXml = opts.programArguments.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("");
  const envXml = Object.entries(opts.environment ?? {})
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("");
  // StartInterval, not KeepAlive: the watchdog must run, report, and exit. A
  // long-lived watcher can wedge exactly like the thing it watches.
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>`
    + `<key>Label</key><string>${WATCHDOG_LABEL}</string>`
    + `<key>ProgramArguments</key><array>${argsXml}</array>`
    + (envXml ? `<key>EnvironmentVariables</key><dict>${envXml}</dict>` : "")
    + `<key>RunAtLoad</key><true/>`
    + `<key>StartInterval</key><integer>${opts.intervalSec ?? WATCHDOG_INTERVAL_SEC}</integer>`
    + `<key>StandardOutPath</key><string>${xmlEscape(opts.logPath)}</string>`
    + `<key>StandardErrorPath</key><string>${xmlEscape(opts.logPath)}</string>`
    + `</dict></plist>`;
}

export function watchdogProgramArguments(opts: {
  dataDir: string;
  distCliPath: string;
  srcCliPath: string;
}): string[] {
  if (existsSync(opts.distCliPath)) {
    return [stableNodePath(), opts.distCliPath, "daemon", "watch", "--data", opts.dataDir];
  }
  return ["/usr/bin/env", "npx", "tsx", opts.srcCliPath, "daemon", "watch", "--data", opts.dataDir];
}

export function installWatchdogAgent(opts: {
  dataDir: string;
  distCliPath: string;
  srcCliPath: string;
  intervalSec?: number;
}): { ok: true; label: string; plist: string; running: boolean } {
  const uid = process.getuid?.() ?? 0;
  const plistPath = watchdogPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  const programArguments = watchdogProgramArguments(opts);
  const environment: Record<string, string> = {};
  if (programArguments[0] === "/usr/bin/env") {
    environment.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  }
  writeFileSync(plistPath, watchdogPlistXml({
    programArguments,
    logPath: watchdogLogPath(opts.dataDir),
    intervalSec: opts.intervalSec,
    environment,
  }));
  spawnSync("launchctl", ["bootout", `gui/${uid}/${WATCHDOG_LABEL}`], { stdio: "ignore" });
  spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  const running = spawnSync("launchctl", ["print", `gui/${uid}/${WATCHDOG_LABEL}`], { stdio: "ignore" }).status === 0;
  return { ok: true, label: WATCHDOG_LABEL, plist: plistPath, running };
}

export function uninstallWatchdogAgent(): { ok: true; label: string } {
  const uid = process.getuid?.() ?? 0;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${WATCHDOG_LABEL}`], { stdio: "ignore" });
  rmSync(watchdogPlistPath(), { force: true });
  return { ok: true, label: WATCHDOG_LABEL };
}

/**
 * Bring the controller back. Only ever touches this launchd label — never a
 * process tree, and never a GUI application.
 *
 * Kickstart alone is not enough: it fails when the job is gone from launchd,
 * and when launchd refuses to exec the program (exit 78 after the app bundle
 * was rebuilt and re-signed, 2026-09-18). Re-bootstrapping the plist recovers
 * both, which is what a person would have had to do by hand.
 */
export function reviveController(): { ok: boolean; detail: string } {
  const uid = process.getuid?.() ?? 0;
  const kick = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${CONTROLLER_LABEL}`], { encoding: "utf8" });
  if (kick.status === 0) return { ok: true, detail: "kickstarted the controller job" };
  const plist = controllerPlistPath();
  if (!existsSync(plist)) {
    return { ok: false, detail: `no controller plist at ${plist}; run: heiss-farm daemon install` };
  }
  spawnSync("launchctl", ["bootout", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
  if (boot.status !== 0) {
    return { ok: false, detail: (boot.stderr || `launchctl bootstrap failed (${boot.status})`).trim() };
  }
  spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${CONTROLLER_LABEL}`], { stdio: "ignore" });
  return { ok: true, detail: "re-registered the controller job with launchd" };
}

/** Last exit status launchd recorded for the controller, when it can be read. */
export function controllerLastExitCode(): number | undefined {
  const uid = process.getuid?.() ?? 0;
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${CONTROLLER_LABEL}`], { encoding: "utf8" });
  const match = /last exit code = (\d+)/.exec(result.stdout ?? "");
  return match ? Number(match[1]) : undefined;
}
