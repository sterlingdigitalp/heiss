/**
 * Health checking + self-healing for the on-device XCTest automation runner.
 * The daemon calls ensureAutomationRunner before device work so a dead or
 * wedged runner is relaunched without human intervention.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { RealUsbTransport } from "./ios-transport.js";
import { RUNNER_BUILD, RUNNER_PROTOCOL_VERSION } from "@heiss/core";
import { listUsbIphones } from "./usb.js";
import {
  automationRunnerLabel,
  downloadBuildInstallRunner,
  launchAutomationRunner,
  runnerWorkDir,
  waitForAutomationRunnerReady,
} from "./runner-install.js";

const execFileAsync = promisify(execFile);

export interface AutomationHealth {
  udid: string;
  label: string;
  /** launchd job is loaded (submitted or bootstrapped). */
  jobLoaded: boolean;
  /** The runner answered a ping over the USB file channel. */
  pingOk: boolean;
  healthy: boolean;
  detail: string;
  protocolVersion?: number;
  runnerBuild?: string;
  protocolCompatible: boolean;
  /** True ONLY when the runner answered with a version that differs. A ping
   *  timeout leaves this false — it is not evidence of a wrong build. */
  protocolMismatch: boolean;
}

export type RunnerRepairAction = "none" | "relaunch" | "reinstall";

export interface RunnerRepairResult {
  ok: boolean;
  action: RunnerRepairAction;
  detail: string;
}

export type DeviceSupervisorAction = RunnerRepairAction | "coredevice_restart" | "restart_deferred" | "unlock_required" | "offline";

export interface DeviceSupervisorResult {
  ok: boolean;
  action: DeviceSupervisorAction;
  checks: {
    usb: boolean;
    paired: boolean;
    commandChannel: boolean;
    runnerHeartbeat: boolean;
    protocolCompatible?: boolean;
  };
  detail: string;
}

/** True when a prior `runner install` left relaunchable build products. */
export function hasAutomationBuildProducts(): boolean {
  return (
    existsSync(join(runnerWorkDir(), "HeissRunner", "HeissRunner.xcodeproj")) &&
    existsSync(
      join(
        runnerWorkDir(),
        "DerivedData",
        "Build",
        "Products",
        "Release-iphoneos",
        "HeissRunnerUITests-Runner.app",
      ),
    )
  );
}

/** Pure decision: what repair does an unhealthy runner need? */
export function planRunnerRepair(
  healthy: boolean,
  buildProductsPresent: boolean,
): RunnerRepairAction {
  if (healthy) return "none";
  return buildProductsPresent ? "relaunch" : "reinstall";
}

/**
 * Check launchd job presence AND live responsiveness. A loaded-but-wedged
 * xcodebuild (hung device session, locked phone) fails the ping and is
 * treated as unhealthy.
 */
export async function checkAutomationRunner(
  udid: string,
  opts: { pingTimeoutMs?: number } = {},
): Promise<AutomationHealth> {
  const label = automationRunnerLabel(udid);
  const uid = process.getuid?.() ?? 0;
  let jobLoaded = false;
  try {
    await execFileAsync("launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000 });
    jobLoaded = true;
  } catch {
    jobLoaded = false;
  }
  let pingOk = false;
  let detail = "";
  let protocolVersion: number | undefined;
  let runnerBuild: string | undefined;
  let protocolCompatible = false;
  let protocolMismatch = false;
  const transport = new RealUsbTransport({ commandTimeoutMs: opts.pingTimeoutMs ?? 20_000 });
  try {
    const info = await transport.runnerInfo(udid);
    // The runner answered — distinguish a real version mismatch (needs a
    // rebuild) from a delivery failure (just needs a relaunch/retry).
    pingOk = true;
    protocolVersion = info.protocolVersion;
    runnerBuild = info.runnerBuild;
    protocolCompatible = info.compatible;
    protocolMismatch = !info.compatible;
    detail = info.compatible
      ? `xctest-ready v${info.protocolVersion}/${info.runnerBuild}`
      : `protocol mismatch: expected v${RUNNER_PROTOCOL_VERSION}/${RUNNER_BUILD}, got v${info.protocolVersion}/${info.runnerBuild}`;
  } catch (error) {
    // No response at all — transport/contention failure, not a wrong build.
    detail = error instanceof Error ? error.message : String(error);
  }
  return {
    udid, label, jobLoaded, pingOk,
    healthy: jobLoaded && pingOk && protocolCompatible,
    detail, protocolVersion, runnerBuild, protocolCompatible, protocolMismatch,
  };
}

/**
 * Make the automation runner usable: no-op when healthy, relaunch from the
 * existing build products when possible, full rebuild + reinstall otherwise.
 */
export async function ensureAutomationRunner(
  udid: string,
  opts: {
    repoRoot?: string;
    pingTimeoutMs?: number;
    readyTimeoutMs?: number;
  } = {},
): Promise<RunnerRepairResult> {
  const health = await checkAutomationRunner(udid, opts);
  // Only a CONFIRMED protocol mismatch (the runner answered with a different
  // version) justifies a full rebuild. A ping that merely failed to deliver
  // is transport contention — relaunch the existing build instead of forcing
  // an expensive, device-busy-prone rebuild.
  const action = health.protocolMismatch
    ? "reinstall"
    : planRunnerRepair(health.healthy, hasAutomationBuildProducts());
  if (action === "none") {
    return { ok: true, action, detail: `automation runner healthy (${health.detail})` };
  }
  if (action === "relaunch") {
    const launched = await launchAutomationRunner(udid, join(runnerWorkDir(), "HeissRunner"));
    const state = await waitForAutomationRunnerReady(
      launched.label,
      launched.logPath,
      opts.readyTimeoutMs ?? 300_000,
    );
    if (state !== "ready") {
      return { ok: false, action, detail: `relaunch ${state}; see ${launched.logPath}` };
    }
    const after = await checkAutomationRunner(udid, opts);
    return after.healthy
      ? { ok: true, action, detail: `relaunched automation runner (${launched.label})` }
      : { ok: false, action, detail: `relaunched but ping failed: ${after.detail}` };
  }
  const install = await downloadBuildInstallRunner({
    udid,
    repoRoot: opts.repoRoot,
    waitForDevice: false,
  });
  return { ok: true, action, detail: `rebuilt and reinstalled runner (${install.installedAt})` };
}

/**
 * Full pre-session ladder: USB/pairing → command-channel heartbeat → runner
 * repair → bounded CoreDevice restart. Lock/passcode failures stop before
 * service restarts and produce a precise user action.
 */
export async function superviseDeviceHealth(
  udid: string,
  opts: {
    repoRoot?: string;
    pingTimeoutMs?: number;
    readyTimeoutMs?: number;
    /** Restarting CoreDeviceService disrupts every attached device; the caller
     *  sets this false when another device has active work in flight. */
    allowServiceRestart?: boolean;
  } = {},
): Promise<DeviceSupervisorResult> {
  const devices = await listUsbIphones().catch(() => []);
  const device = devices.find((candidate) => candidate.udid === udid);
  const baseChecks = {
    usb: Boolean(device?.available),
    paired: Boolean(device?.paired),
    commandChannel: false,
    runnerHeartbeat: false,
  };
  if (!device?.available) {
    return {
      ok: false, action: "offline", checks: baseChecks,
      detail: device ? `${device.name} is paired but not available over USB` : `iPhone ${udid.slice(0, 8)} is not on USB`,
    };
  }

  const before = await checkAutomationRunner(udid, opts);
  if (before.healthy) {
    return {
      ok: true, action: "none",
      checks: { ...baseChecks, commandChannel: before.pingOk, runnerHeartbeat: before.healthy, protocolCompatible: before.protocolCompatible },
      detail: `USB, app-container command channel, and runner heartbeat are healthy (${before.detail})`,
    };
  }
  if (/locked|passcode|unlock|developer mode/i.test(before.detail)) {
    return {
      ok: false, action: "unlock_required", checks: baseChecks,
      detail: `Unlock ${device.name} and leave it connected: ${before.detail}`,
    };
  }

  const repair = await ensureAutomationRunner(udid, opts);
  if (repair.ok) {
    const afterRepair = await checkAutomationRunner(udid, opts);
    if (afterRepair.healthy) {
      return {
        ok: true, action: repair.action,
        checks: { ...baseChecks, commandChannel: true, runnerHeartbeat: true, protocolCompatible: afterRepair.protocolCompatible },
        detail: repair.detail,
      };
    }
  }

  if (opts.allowServiceRestart === false) {
    return {
      ok: false, action: "restart_deferred",
      checks: { ...baseChecks, commandChannel: before.pingOk, runnerHeartbeat: before.healthy, protocolCompatible: before.protocolCompatible },
      detail: `${device.name} runner still unhealthy; CoreDevice restart deferred to avoid disrupting other active devices: ${before.detail}`,
    };
  }
  try {
    await execFileAsync("pkill", ["-u", String(process.getuid?.() ?? 0), "-x", "CoreDeviceService"], { timeout: 5_000 });
  } catch { /* service may have already exited */ }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const finalRepair = await ensureAutomationRunner(udid, opts).catch((error) => ({
    ok: false, action: "relaunch" as const,
    detail: error instanceof Error ? error.message : String(error),
  }));
  const final = await checkAutomationRunner(udid, opts);
  return {
    ok: final.healthy,
    action: "coredevice_restart",
    checks: { ...baseChecks, commandChannel: final.pingOk, runnerHeartbeat: final.healthy, protocolCompatible: final.protocolCompatible },
    detail: final.healthy
      ? `CoreDevice and runner recovered (${finalRepair.detail})`
      : `CoreDevice restart exhausted; user intervention required: ${final.detail}`,
  };
}
