/**
 * Setup state machine: detect USB → runner → signing → accounts → warmups.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listUsbIphones, pollUntilReady, type UsbIphone } from "./usb.js";
import {
  detectLocalTeams,
  planSigning,
  resolveSigningConfig,
  type SignResult,
} from "./signing.js";
import { isRunnerInstalled, downloadBuildInstallRunner } from "./runner-install.js";

export type SetupStepId =
  | "xcode_tools"
  | "signing"
  | "usb_device"
  | "runner_installed"
  | "device_registered"
  | "account_added"
  | "warmup_started";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  done: boolean;
  humanOnly: boolean;
  detail: string;
  hint?: string;
}

export interface SetupStatus {
  ready: boolean;
  steps: SetupStep[];
  devices: UsbIphone[];
  signing: SignResult | { error: string };
  nextHumanAction?: string;
}

export async function getSetupStatus(opts?: {
  hasRegisteredDevice?: boolean;
  hasAccount?: boolean;
  hasWarmupSession?: boolean;
}): Promise<SetupStatus> {
  const steps: SetupStep[] = [];

  // Xcode
  let xcodeOk = false;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("xcrun", ["--version"], { stdio: "pipe" });
    xcodeOk = true;
  } catch {
    xcodeOk = false;
  }
  steps.push({
    id: "xcode_tools",
    title: "Xcode / command line tools",
    done: xcodeOk,
    humanOnly: true,
    detail: xcodeOk
      ? "xcrun available"
      : "Install Xcode from the Mac App Store and open it once",
    hint: "xcode-select --install",
  });

  // Signing
  let signing: SignResult | { error: string };
  try {
    signing = planSigning();
    const teams = await detectLocalTeams();
    const hasTeam = Boolean(
      resolveSigningConfig().teamId ||
        (signing as SignResult).teamId ||
        teams.length > 0 ||
        (signing as SignResult).method === "asc",
    );
    const plan = signing as SignResult;
    steps.push({
      id: "signing",
      title: "Xcode / ASC signing",
      done: hasTeam || plan.method === "asc",
      humanOnly: true,
      detail: `${plan.method}: ${plan.notes.join("; ")}`,
      hint: "Set HEISS_TEAM_ID (Xcode) or HEISS_ASC_KEY_PATH + KEY_ID + ISSUER_ID (ASC)",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    signing = { error: msg };
    steps.push({
      id: "signing",
      title: "Xcode / ASC signing",
      done: false,
      humanOnly: true,
      detail: msg,
      hint: "Add Apple ID in Xcode → Settings → Accounts, set Team on the runner target",
    });
  }

  // USB
  let devices: UsbIphone[] = [];
  try {
    devices = await listUsbIphones();
  } catch {
    devices = [];
  }
  const usbReady = devices.some((d) => d.available);
  steps.push({
    id: "usb_device",
    title: "USB iPhone connected & trusted",
    done: usbReady,
    humanOnly: true,
    detail: usbReady
      ? devices.map((d) => `${d.name} (${d.udid.slice(0, 8)}…)`).join(", ")
      : "Plug in iPhone, unlock, tap Trust This Computer",
    hint: "Use a data USB cable; enable Developer Mode in Settings → Privacy & Security",
  });

  // Runner
  const runnerOk =
    usbReady && devices.some((d) => isRunnerInstalled(d.udid));
  steps.push({
    id: "runner_installed",
    title: "HeissRunner installed on device",
    done: runnerOk,
    humanOnly: false,
    detail: runnerOk
      ? "Runner install record present"
      : "Run: heiss-farm runner install",
    hint: "After install: Settings → General → VPN & Device Management → Trust developer",
  });

  steps.push({
    id: "device_registered",
    title: "Device registered in farm store",
    done: Boolean(opts?.hasRegisteredDevice),
    humanOnly: false,
    detail: opts?.hasRegisteredDevice
      ? "Device in ~/.heiss/live/farm.json"
      : "Run: heiss-farm devices sync",
  });

  steps.push({
    id: "account_added",
    title: "Social account added",
    done: Boolean(opts?.hasAccount),
    humanOnly: true,
    detail: opts?.hasAccount
      ? "Account(s) present"
      : "Log into TikTok/IG on the phone, then: heiss-farm add-account …",
    hint: "You must log into the social app on the iPhone yourself",
  });

  steps.push({
    id: "warmup_started",
    title: "Warmup / farm run started",
    done: Boolean(opts?.hasWarmupSession),
    humanOnly: false,
    detail: opts?.hasWarmupSession
      ? "Sessions recorded"
      : "Run: heiss-farm run --time HH:mm",
  });

  const ready = steps.every((s) => s.done);
  const next = steps.find((s) => !s.done);
  return {
    ready,
    steps,
    devices,
    signing,
    nextHumanAction: next?.humanOnly
      ? `${next.title}: ${next.hint ?? next.detail}`
      : next
        ? `Agent can run: ${next.detail}`
        : undefined,
  };
}

export async function setupDeviceAndRunner(opts?: {
  udid?: string;
  teamId?: string;
  repoRoot?: string;
}): Promise<{
  device: UsbIphone;
  install: Awaited<ReturnType<typeof downloadBuildInstallRunner>>;
}> {
  const device = await pollUntilReady({ udid: opts?.udid });
  const install = await downloadBuildInstallRunner({
    udid: device.udid,
    repoRoot: opts?.repoRoot,
    signing: opts?.teamId ? { teamId: opts.teamId, method: "xcode" } : undefined,
  });
  return { device, install };
}

export function loadRunnerInstallRecords(): Record<string, unknown> {
  const p = join(homedir(), ".heiss", "runner-installs.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}
