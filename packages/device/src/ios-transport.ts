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
import type { IosTransport } from "./ios-driver.js";
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
}

/**
 * Production transport: list real devices, install runner, send actions to device.
 */
export class RealUsbTransport implements IosTransport {
  readonly kind = "usb" as const;
  private bundleId: string;
  private commandTimeoutMs: number;
  private lastDevices: UsbIphone[] = [];

  constructor(opts: RealUsbTransportOptions = {}) {
    this.bundleId = opts.bundleId ?? `${RUNNER_BUNDLE_ID}.xctrunner`;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 45_000;
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
    context: Record<string, unknown> = {},
  ): Promise<{ ok: true; detail: string }> {
    const result = await this.sendCommand(udid, { action, ...context });
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

  private async sendCommand(
    udid: string,
    cmd: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const work = join(tmpdir(), `heiss-cmd-${id}`);
    mkdirSync(work, { recursive: true });
    const localIn = join(work, `${id}.json`);
    const payload: Record<string, unknown> = { ...cmd, id, ts: new Date().toISOString() };

    // Stage local Cloud Drop media inside the XCTest runner container. The
    // runner imports it into Photos before opening TikTok/Instagram's picker.
    const mediaRefs = [...new Set(
      [cmd.mediaRef, ...(Array.isArray(cmd.slides) ? cmd.slides : [])]
        .filter((value): value is string => typeof value === "string" && existsSync(value)),
    )];
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
    } catch (e) {
      // Fallback: launch runner and use process launch with environment — still real device
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

    // Poll outbox
    const action = String(cmd.action);
    const actionTimeout = action.startsWith("post:") || action.startsWith("warmup:")
      ? Math.max(this.commandTimeoutMs, 120_000)
      : this.commandTimeoutMs;
    const deadline = Date.now() + actionTimeout;
    const remoteOut = `Documents/outbox/${id}.json`;
    const localOut = join(work, `out-${id}.json`);
    while (Date.now() < deadline) {
      try {
        await this.copyFromDevice(udid, remoteOut, localOut);
        if (existsSync(localOut)) {
          const result = JSON.parse(readFileSync(localOut, "utf8")) as Record<
            string,
            unknown
          >;
          rmSync(work, { recursive: true, force: true });
          return result;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 400));
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
export function createProductionTransport(): RealUsbTransport {
  return new RealUsbTransport();
}

export { installAppOnDevice };
