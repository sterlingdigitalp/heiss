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
}

export type RunnerRepairAction = "none" | "relaunch" | "reinstall";

export interface RunnerRepairResult {
  ok: boolean;
  action: RunnerRepairAction;
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
  const transport = new RealUsbTransport({ commandTimeoutMs: opts.pingTimeoutMs ?? 20_000 });
  try {
    const result = await transport.runScriptAction(udid, "ping");
    pingOk = result.ok;
    detail = result.detail;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  return { udid, label, jobLoaded, pingOk, healthy: jobLoaded && pingOk, detail };
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
  const action = planRunnerRepair(health.healthy, hasAutomationBuildProducts());
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
