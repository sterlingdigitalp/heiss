/**
 * Real USB transport to HeissRunner on a physical iPhone.
 * Commands are delivered via devicectl file copy into the app Documents inbox.
 * No simulator. No unofficial social APIs.
 */
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { DeviceSessionError, type IosTransport } from "./ios-driver.js";
import {
  RUNNER_BUILD,
  RUNNER_PROTOCOL_VERSION,
  type DeviceActionContext,
  type DeviceSessionResult,
  type FailureKind,
  type RunnerProtocolInfo,
} from "@heiss/core";
import { listUsbIphones, type UsbIphone } from "./usb.js";
import {
  downloadBuildInstallRunner,
  installAppOnDevice,
  launchAutomationRunner,
  runnerWorkDir,
  waitForAutomationRunnerReady,
  RUNNER_BUNDLE_ID,
} from "./runner-install.js";

const execFileAsync = promisify(execFile);

export interface RealUsbTransportOptions {
  /** App group container path pattern — uses AFC/devicectl copy when available */
  bundleId?: string;
  commandTimeoutMs?: number;
  /** Receives durable on-device journal updates while a batch is running. */
  onProgress?: (progress: Record<string, unknown>) => void;
}

/**
 * Production transport: list real devices, install runner, send actions to device.
 */
export class RealUsbTransport implements IosTransport {
  readonly kind = "usb" as const;
  private bundleId: string;
  private commandTimeoutMs: number;
  private onProgress?: (progress: Record<string, unknown>) => void;
  private lastDevices: UsbIphone[] = [];

  constructor(opts: RealUsbTransportOptions = {}) {
    this.bundleId = opts.bundleId ?? `${RUNNER_BUNDLE_ID}.xctrunner`;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 45_000;
    this.onProgress = opts.onProgress;
  }

  async listDevices(): Promise<{ udid: string; name: string }[]> {
    this.lastDevices = await listUsbIphones();
    return this.lastDevices
      .filter((d) => d.available)
      .map((d) => ({ udid: d.udid, name: d.name }));
  }

  async installRunner(udid: string): Promise<void> {
    await downloadBuildInstallRunner({ udid, waitForDevice: true });
  }

  async runnerInfo(udid: string): Promise<RunnerProtocolInfo> {
    const result = await this.sendCommand(udid, { action: "ping" });
    const protocolVersion = Number(result.protocolVersion ?? 0);
    const runnerBuild = String(result.runnerBuild ?? "unknown");
    const freeBytes = result.freeBytes === undefined ? undefined : Number(result.freeBytes);
    return {
      protocolVersion,
      runnerBuild,
      compatible: protocolVersion === RUNNER_PROTOCOL_VERSION && runnerBuild === RUNNER_BUILD,
      freeBytes,
    };
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    await this.sendCommand(udid, {
      action: "tap",
      x,
      y,
    });
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<void> {
    await this.sendCommand(udid, {
      action: "swipe",
      x1,
      y1,
      x2,
      y2,
    });
  }

  async screenshot(udid: string): Promise<Buffer> {
    const result = await this.sendCommand(udid, { action: "screenshot" });
    if (result.base64) {
      return Buffer.from(String(result.base64), "base64");
    }
    if (result.ok === true && result.executed === true && typeof result.screenshot === "string") {
      const local = join(tmpdir(), `heiss-screenshot-${randomUUID()}.png`);
      try {
        await this.copyFromDevice(udid, `Documents/screenshots/${basename(result.screenshot)}`, local);
        return readFileSync(local);
      } finally {
        rmSync(local, { force: true });
      }
    }
    throw new Error(
      `HeissRunner did not capture a screenshot: ${String(result.detail ?? "missing screenshot acknowledgement")}`,
    );
  }

  /**
   * Send a high-level farm action (warmup:scroll, post:publish, …).
   */
  async runScriptAction(
    udid: string,
    action: string,
    context?: DeviceActionContext,
  ): Promise<{ ok: true; detail: string }> {
    const result = await this.sendCommand(udid, { action, ...(context ?? {}) });
    if (Number(result.protocolVersion ?? 0) !== RUNNER_PROTOCOL_VERSION
        || String(result.runnerBuild ?? "") !== RUNNER_BUILD) {
      throw new Error(
        `Runner protocol mismatch: expected v${RUNNER_PROTOCOL_VERSION}/${RUNNER_BUILD}, got v${String(result.protocolVersion ?? "?")}/${String(result.runnerBuild ?? "unknown")}`,
      );
    }
    if (result.ok !== true || result.executed !== true) {
      let screenshotNote = "";
      if (typeof result.screenshot === "string") {
        const failures = join(homedir(), ".heiss", "failures");
        mkdirSync(failures, { recursive: true });
        const local = join(failures, `${udid.slice(0, 8)}-${basename(result.screenshot)}`);
        try {
          await this.copyFromDevice(udid, `Documents/screenshots/${result.screenshot}`, local);
          screenshotNote = ` Screenshot saved to ${local}.`;
        } catch { /* retain the on-device screenshot name in result.detail */ }
      }
      throw new Error(
        `Runner did not execute ${action}: ${String(result.detail ?? "missing execution acknowledgement")}.${screenshotNote}`,
      );
    }
    return {
      ok: true,
      detail: String(result.detail ?? `ios:${action}@${udid.slice(0, 8)}`),
    };
  }

  async runScriptSession(
    udid: string,
    sessionId: string,
    plannedSteps: string[],
    startIndex: number,
    context: DeviceActionContext,
  ): Promise<DeviceSessionResult> {
    const result = await this.sendCommand(udid, {
      action: "warmup:session",
      sessionId,
      plannedSteps,
      startIndex,
      ...context,
    });
    if (Number(result.protocolVersion ?? 0) !== RUNNER_PROTOCOL_VERSION
        || String(result.runnerBuild ?? "") !== RUNNER_BUILD) {
      throw new DeviceSessionError(
        `Runner protocol mismatch: expected v${RUNNER_PROTOCOL_VERSION}/${RUNNER_BUILD}, got v${String(result.protocolVersion ?? "?")}/${String(result.runnerBuild ?? "unknown")}`,
        "runner",
        startIndex,
      );
    }
    const completedSteps = Number(result.completedSteps ?? startIndex);
    if (result.ok !== true || result.executed !== true) {
      let screenshotPath: string | undefined;
      if (typeof result.screenshot === "string") {
        const failures = join(homedir(), ".heiss", "failures");
        mkdirSync(failures, { recursive: true });
        const local = join(failures, `${udid.slice(0, 8)}-${basename(result.screenshot)}`);
        try {
          await this.copyFromDevice(udid, `Documents/screenshots/${result.screenshot}`, local);
          screenshotPath = local;
        } catch { /* the device result still retains its screenshot name */ }
      }
      const kind = normalizeFailureKind(result.failureKind);
      throw new DeviceSessionError(
        `${String(result.detail ?? "on-device session failed")}${screenshotPath ? `. Screenshot saved to ${screenshotPath}.` : ""}`,
        kind,
        completedSteps,
        screenshotPath,
        Array.isArray(result.stepDetails) ? result.stepDetails.map((value) => String(value)) : undefined,
      );
    }
    return {
      ok: true,
      detail: String(result.detail ?? `ios:session@${udid.slice(0, 8)}`),
      completedSteps,
      stepDetails: Array.isArray(result.stepDetails)
        ? result.stepDetails.map((value) => String(value))
        : undefined,
      heartbeatAt: typeof result.heartbeatAt === "string" ? result.heartbeatAt : undefined,
      journal: typeof result.journal === "string" ? result.journal : undefined,
    };
  }

  private async sendCommand(
    udid: string,
    cmd: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const work = join(tmpdir(), `heiss-cmd-${id}`);
    mkdirSync(work, { recursive: true });
    const localIn = join(work, `${id}.json`);
    const payload: Record<string, unknown> = {
      ...cmd, id, commandGeneration: id,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      expectedRunnerBuild: RUNNER_BUILD,
      ts: new Date().toISOString(),
    };

    // Stage local Cloud Drop media inside the XCTest runner container. The
    // runner imports it into Photos before opening a platform media picker.
    // A supplied asset that is missing on disk is a hard error: silently
    // dropping it used to send the device an empty staged list, which then
    // published an arbitrary camera-roll photo to a real account.
    const suppliedRefs = [cmd.mediaRef, ...(Array.isArray(cmd.slides) ? cmd.slides : [])]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const missingRefs = suppliedRefs.filter((value) => !existsSync(value));
    if (missingRefs.length > 0) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(
        `Refusing to send ${String(cmd.action)} to ${udid.slice(0, 8)}: staged media missing on disk: ${missingRefs.join(", ")}`,
      );
    }
    const mediaRefs = [...new Set(suppliedRefs)];
    if (mediaRefs.length > 0) {
      const stagedMediaNames: string[] = [];
      for (const [index, mediaPath] of mediaRefs.entries()) {
        const name = `${id}-${index}-${basename(mediaPath).replace(/[^a-zA-Z0-9._-]/g, "-")}`;
        await this.copyToDevice(udid, mediaPath, `Documents/media/${name}`);
        stagedMediaNames.push(name);
      }
      payload.stagedMediaNames = stagedMediaNames;
    }
    writeFileSync(localIn, JSON.stringify(payload));

    // Push into app container Documents/inbox via devicectl copy
    // Path convention used by HeissRunner ControlServer
    const remoteInbox = `Documents/inbox/${id}.json`;
    try {
      await this.copyToDevice(udid, localIn, remoteInbox);
    } catch {
      // CoreDevice can briefly hold the XCTest app-data container while the
      // freshly launched test host attaches. Retry the same idempotent file
      // copy before deciding the runner is dead; relaunching a healthy host on
      // one transient timeout creates an avoidable automation-mode race.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      try {
        await this.copyToDevice(udid, localIn, remoteInbox);
      } catch {
        // Fallback: only now relaunch the XCTest command server, then make one
        // final delivery attempt over the real-device file channel.
        await this.ensureRunnerLaunched(udid);
        try {
          await this.copyToDevice(udid, localIn, remoteInbox);
        } catch (retryError) {
          rmSync(work, { recursive: true, force: true });
          throw new Error(
            `Unable to deliver ${String(cmd.action)} to HeissRunner on ${udid.slice(0, 8)}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
        }
      }
    }

    // Poll outbox
    const action = String(cmd.action);
    const actionTimeout = action === "warmup:session"
      ? Math.max(this.commandTimeoutMs, 15 * 60_000)
      : action === "verify:account"
        ? Math.max(this.commandTimeoutMs, 180_000)
        : action.startsWith("post:") || action.startsWith("warmup:")
        ? Math.max(this.commandTimeoutMs, 120_000)
        : this.commandTimeoutMs;
    const deadline = Date.now() + actionTimeout;
    const remoteOut = `Documents/outbox/${id}.json`;
    const localOut = join(work, `out-${id}.json`);
    const sessionId = typeof cmd.sessionId === "string" ? cmd.sessionId : undefined;
    const safeSessionId = sessionId?.replace(/[^A-Za-z0-9._-]/g, "-");
    const remoteJournal = safeSessionId ? `Documents/journals/${safeSessionId}.json` : undefined;
    const localJournal = safeSessionId ? join(work, `journal-${safeSessionId}.json`) : undefined;
    let lastJournalStep = -1;
    let nextJournalPoll = 0;
    // Every poll spawns a `devicectl device copy from` process that opens a
    // fresh XPC connection to CoreDeviceService. A flat 400ms against a
    // 15-minute batched-session deadline is ~2,250 connections for a single
    // account, and CoreDeviceService reliably wedges under that load ("the
    // connection was interrupted"), taking the whole farm offline until the Mac
    // is rebooted. Stay responsive for short commands, then back off hard —
    // a batched session cannot possibly answer in its first minute anyway.
    const pollStartedAt = Date.now();
    const pollDelay = () => {
      const elapsed = Date.now() - pollStartedAt;
      if (elapsed < 5_000) return 400;
      if (elapsed < 60_000) return 1_500;
      return 4_000;
    };
    while (Date.now() < deadline) {
      if (remoteJournal && localJournal && this.onProgress && Date.now() >= nextJournalPoll) {
        nextJournalPoll = Date.now() + 5_000;
        try {
          await this.copyFromDevice(udid, remoteJournal, localJournal);
          const progress = JSON.parse(readFileSync(localJournal, "utf8")) as Record<string, unknown>;
          if (progress.commandGeneration !== id) continue;
          const completed = Number(progress.completedSteps ?? -1);
          if (completed !== lastJournalStep) {
            lastJournalStep = completed;
            this.onProgress({ ...progress, udid, receivedAt: new Date().toISOString() });
          }
        } catch { /* journal is created only after account verification */ }
      }
      try {
        await this.copyFromDevice(udid, remoteOut, localOut);
        if (existsSync(localOut)) {
          const result = JSON.parse(readFileSync(localOut, "utf8")) as Record<
            string,
            unknown
          >;
          if (result.commandGeneration && result.commandGeneration !== id) continue;
          rmSync(work, { recursive: true, force: true });
          return result;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, pollDelay()));
    }
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `HeissRunner did not acknowledge ${String(cmd.action)} within ${actionTimeout}ms`,
    );
  }

  private async ensureRunnerLaunched(udid: string): Promise<void> {
    // Launching the xctrunner app bundle via devicectl cannot revive the
    // XCTest command server — only xcodebuild test-without-building can.
    // Relaunch the automation job from the last install's build products.
    try {
      const sourceDir = join(runnerWorkDir(), "HeissRunner");
      if (!existsSync(join(sourceDir, "HeissRunner.xcodeproj"))) return;
      const launched = await launchAutomationRunner(udid, sourceDir);
      await waitForAutomationRunnerReady(launched.label, launched.logPath, 120_000);
    } catch {
      /* best effort — the caller retries the copy and reports the real error */
    }
  }

  private copyToDevice(
    udid: string,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    return this.copyWithTimeout("to", udid, localPath, remotePath);
  }

  private copyFromDevice(
    udid: string,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    return this.copyWithTimeout("from", udid, remotePath, localPath);
  }

  private copyWithTimeout(
    direction: "to" | "from",
    udid: string,
    source: string,
    destination: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // devicectl device copy to
      const child = spawn(
        "xcrun",
        [
          "devicectl",
          "device",
          "copy",
          direction,
          "--device",
          udid,
          "--domain-type",
          "appDataContainer",
          "--domain-identifier",
          this.bundleId,
          "--source",
          source,
          "--destination",
          destination,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`copy ${direction} device timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`copy ${direction} device failed: ${stderr || `exit ${code}`}`));
      });
    });
  }
}

/** Factory used by farm CLI and Heiss.app — always real USB, never simulator. */
export function createProductionTransport(opts: RealUsbTransportOptions = {}): RealUsbTransport {
  return new RealUsbTransport(opts);
}

export { installAppOnDevice };

function normalizeFailureKind(value: unknown): FailureKind {
  return typeof value === "string" && [
    "transport", "runner", "unknown_ui", "account_mismatch",
    "app_navigation", "safety_policy", "action",
  ].includes(value) ? value as FailureKind : "action";
}
