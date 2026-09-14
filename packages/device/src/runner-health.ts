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
import { withRunnerBuildLock } from "./runner-lock.js";
import {
  diagnoseRunnerFailure,
  runnerFailureEvidence,
  type RunnerDiagnosis,
  type RunnerFailureCause,
} from "./runner-diagnosis.js";
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
  /** Free bytes the runner reported. undefined when the runner did not answer
   *  or predates free-space reporting; negative when the device could not tell. */
  freeBytes?: number;
}

export type StorageLevel = "ok" | "warn" | "critical";

/** Warn while there is still ~a week of runway (the SE fills ~6-7 GB/day under
 *  24/7 XCTest), so the operator hears about it long before iOS throws its
 *  storage-full alert and blocks automation. */
export const STORAGE_WARN_BYTES = 6 * 1024 ** 3;
/** Below this, act now: trigger the aggressive on-device cache clear and raise
 *  an urgent alert. */
export const STORAGE_CRITICAL_BYTES = 3 * 1024 ** 3;

/** Classify reported free space. Unknown/undefined/negative → "ok" so a runner
 *  that cannot report never produces a false low-space alarm. */
export function classifyStorage(freeBytes: number | undefined): StorageLevel {
  if (freeBytes === undefined || !Number.isFinite(freeBytes) || freeBytes < 0) return "ok";
  if (freeBytes <= STORAGE_CRITICAL_BYTES) return "critical";
  if (freeBytes <= STORAGE_WARN_BYTES) return "warn";
  return "ok";
}

/** Alert at most once per local day per level change, so a persistently low
 *  device does not notify every tick. Re-alerts when the level worsens the same
 *  day (warn → critical) by keying on `${day}:${level}`. */
export function shouldAlertStorage(
  level: StorageLevel,
  lastAlertKey: string | undefined,
  today: string,
): boolean {
  if (level === "ok") return false;
  return lastAlertKey !== `${today}:${level}`;
}

export type RunnerRepairAction = "none" | "relaunch" | "reinstall";

export interface RunnerRepairResult {
  ok: boolean;
  action: RunnerRepairAction;
  detail: string;
}

export type DeviceSupervisorAction = RunnerRepairAction | "coredevice_restart" | "restart_deferred" | "unlock_required" | "operator_required" | "offline";

export interface DeviceSupervisorResult {
  ok: boolean;
  action: DeviceSupervisorAction;
  /** Named failure cause, when the evidence matched a known one. */
  cause?: RunnerFailureCause;
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
  let freeBytes: number | undefined;
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
    freeBytes = info.freeBytes;
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
    detail, protocolVersion, runnerBuild, protocolCompatible, protocolMismatch, freeBytes,
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
    // Relaunch builds from the shared sources + DerivedData an install rewrites.
    const relaunched = await withRunnerBuildLock(`runner relaunch for ${udid.slice(0, 8)}`, async () => {
      const launched = await launchAutomationRunner(udid, join(runnerWorkDir(), "HeissRunner"));
      const state = await waitForAutomationRunnerReady(
        launched.label,
        launched.logPath,
        opts.readyTimeoutMs ?? 300_000,
      );
      return { launched, state };
    });
    const { launched, state } = relaunched;
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
  // A locked phone or Developer Mode off blocks every repair step, so stop
  // before touching the runner. Other operator-only causes (storage, trust)
  // are only judged after a repair fails: a plain relaunch can still succeed.
  const pre = diagnoseRunnerFailure(before.detail);
  if (pre && (pre.cause === "device_locked" || pre.cause === "developer_mode_off")) {
    return {
      ok: false, action: "unlock_required", cause: pre.cause, checks: baseChecks,
      detail: `${device.name}: ${pre.action} (${before.detail})`,
    };
  }

  const operatorRequired = (diagnosis: RunnerDiagnosis, detail: string): DeviceSupervisorResult => ({
    ok: false, action: "operator_required", cause: diagnosis.cause,
    checks: { ...baseChecks, commandChannel: before.pingOk, runnerHeartbeat: false, protocolCompatible: before.protocolCompatible },
    detail: `${device.name}: ${diagnosis.action} (${firstLine(detail)})`,
  });

  let repair: RunnerRepairResult;
  try {
    repair = await ensureAutomationRunner(udid, opts);
  } catch (error) {
    // A thrown repair keeps propagating as before (including RunnerBusyError,
    // which must not lead to a CoreDevice restart) unless it names a cause
    // only the operator can fix.
    const message = error instanceof Error ? error.message : String(error);
    const diagnosis = diagnoseRunnerFailure(runnerFailureEvidence(message));
    if (diagnosis?.needsHuman) return operatorRequired(diagnosis, message);
    throw error;
  }
  const repairDiagnosis = repair.ok ? undefined : diagnoseRunnerFailure(runnerFailureEvidence(repair.detail));
  // Restarting CoreDevice cannot trust a certificate or free storage.
  if (repairDiagnosis?.needsHuman) return operatorRequired(repairDiagnosis, repair.detail);
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
  const finalDiagnosis = final.healthy
    ? undefined
    : diagnoseRunnerFailure(runnerFailureEvidence(finalRepair.detail, final.detail)) ?? repairDiagnosis;
  return {
    ok: final.healthy,
    action: "coredevice_restart",
    cause: finalDiagnosis?.cause,
    checks: { ...baseChecks, commandChannel: final.pingOk, runnerHeartbeat: final.healthy, protocolCompatible: final.protocolCompatible },
    detail: final.healthy
      ? `CoreDevice and runner recovered (${finalRepair.detail})`
      : `CoreDevice restart exhausted; user intervention required: ${finalDiagnosis ? `${finalDiagnosis.action} ` : ""}${final.detail}`,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? text;
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}
