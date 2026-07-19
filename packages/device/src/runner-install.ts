/**
 * Download (scaffold/sync), build, sign, and install HeissRunner on a physical iPhone.
 */
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { planSigning, type SigningConfig } from "./signing.js";
import { listUsbIphones, pollUntilReady } from "./usb.js";

const execFileAsync = promisify(execFile);

export const RUNNER_BUNDLE_ID = "so.heiss.runner";
export const RUNNER_APP_NAME = "HeissRunner";

function packageRoot(): string {
  // packages/device/src -> packages/device
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

/** Path to vendored iOS runner sources inside the monorepo. */
export function runnerSourceDir(repoRoot?: string): string {
  if (repoRoot) return join(repoRoot, "ios", "HeissRunner");
  // device package lives at packages/device — monorepo root is ../..
  return resolve(packageRoot(), "..", "..", "ios", "HeissRunner");
}

export function runnerWorkDir(): string {
  return join(homedir(), ".heiss", "runner-build");
}

export interface InstallRunnerOptions {
  udid?: string;
  repoRoot?: string;
  signing?: Partial<SigningConfig>;
  /** Skip build if .app already exists */
  useExistingApp?: string;
  /** Poll for device first */
  waitForDevice?: boolean;
  waitTimeoutMs?: number;
}

export interface InstallRunnerResult {
  ok: true;
  udid: string;
  deviceName: string;
  appPath: string;
  bundleId: string;
  signingMethod: string;
  notes: string[];
  installedAt: string;
}

export async function ensureRunnerSources(repoRoot?: string): Promise<string> {
  const src = runnerSourceDir(repoRoot);
  if (!existsSync(join(src, "project.yml")) && !existsSync(join(src, "HeissRunner.xcodeproj"))) {
    throw new Error(
      `HeissRunner sources missing at ${src}. Ensure ios/HeissRunner is present in the repo.`,
    );
  }
  const work = runnerWorkDir();
  mkdirSync(work, { recursive: true });
  const dest = join(work, "HeissRunner");
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(src, dest, { recursive: true });
  return dest;
}

/**
 * Build HeissRunner.app with xcodebuild + automatic signing.
 */
export async function buildRunner(
  sourceDir: string,
  signing?: Partial<SigningConfig>,
  udid?: string,
): Promise<{ appPath: string; testRunnerPath: string; notes: string[] }> {
  const plan = planSigning(signing);
  const derived = join(runnerWorkDir(), "DerivedData");
  mkdirSync(derived, { recursive: true });

  // Prefer xcodeproj; if only project.yml, try xcodegen when available
  let projectArg: string[] = [];
  const xcodeproj = join(sourceDir, "HeissRunner.xcodeproj");
  const workspace = join(sourceDir, "HeissRunner.xcworkspace");
  if (existsSync(workspace)) {
    projectArg = ["-workspace", workspace, "-scheme", RUNNER_APP_NAME];
  } else if (existsSync(xcodeproj)) {
    projectArg = ["-project", xcodeproj, "-scheme", RUNNER_APP_NAME];
  } else if (existsSync(join(sourceDir, "project.yml"))) {
    try {
      await execFileAsync("xcodegen", ["generate"], { cwd: sourceDir });
    } catch {
      // generate minimal xcodeproj via swift package style fallback
      await generateMinimalXcodeproj(sourceDir, plan.bundleId);
    }
    projectArg = [
      "-project",
      join(sourceDir, "HeissRunner.xcodeproj"),
      "-scheme",
      RUNNER_APP_NAME,
    ];
  } else {
    await generateMinimalXcodeproj(sourceDir, plan.bundleId);
    projectArg = [
      "-project",
      join(sourceDir, "HeissRunner.xcodeproj"),
      "-scheme",
      RUNNER_APP_NAME,
    ];
  }

  const args = [
    ...projectArg,
    "-configuration",
    "Release",
    "-destination",
    udid ? `platform=iOS,id=${udid}` : "generic/platform=iOS",
    "-derivedDataPath",
    derived,
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    ...plan.xcodebuildArgs,
    "build-for-testing",
  ];

  try {
    await execFileAsync("xcodebuild", args, {
      cwd: sourceDir,
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        // ASC key material for automatic signing when present
        ...(plan.method === "asc"
          ? {
              APP_STORE_CONNECT_API_KEY_PATH:
                process.env.HEISS_ASC_KEY_PATH ?? process.env.APP_STORE_CONNECT_API_KEY_PATH ?? "",
              APP_STORE_CONNECT_KEY_ID:
                process.env.HEISS_ASC_KEY_ID ?? process.env.APP_STORE_CONNECT_KEY_ID ?? "",
              APP_STORE_CONNECT_ISSUER_ID:
                process.env.HEISS_ASC_ISSUER_ID ??
                process.env.APP_STORE_CONNECT_ISSUER_ID ??
                "",
            }
          : {}),
      },
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const combined = `${err.stderr ?? ""}\n${err.stdout ?? ""}`;
    const diagnostics = combined
      .split("\n")
      .filter((line) => /error:|No Account for Team|No profiles for/.test(line))
      .slice(-12)
      .join("\n");
    throw new Error(
      `xcodebuild failed for HeissRunner.\n` +
        `Ensure Xcode is installed, Apple ID Team is set (HEISS_TEAM_ID), and a real iOS SDK is available.\n` +
        `${diagnostics || err.stderr?.slice(-2000) || err.stdout?.slice(-2000) || err.message}`,
    );
  }

  const appPath = findBuiltApp(derived);
  if (!appPath) {
    throw new Error(`Build succeeded but HeissRunner.app not found under ${derived}`);
  }
  const testRunnerPath = join(derived, "Build", "Products", "Release-iphoneos", "HeissRunnerUITests-Runner.app");
  if (!existsSync(testRunnerPath)) {
    throw new Error(`Build succeeded but HeissRunnerUITests-Runner.app not found under ${derived}`);
  }
  return { appPath, testRunnerPath, notes: plan.notes };
}

function findBuiltApp(derived: string): string | null {
  const candidates = [
    join(derived, "Build", "Products", "Release-iphoneos", `${RUNNER_APP_NAME}.app`),
    join(derived, "Build", "Products", "Debug-iphoneos", `${RUNNER_APP_NAME}.app`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const stdout = execFileSync(
      "find",
      [derived, "-name", `${RUNNER_APP_NAME}.app`, "-type", "d"],
      { encoding: "utf8" },
    );
    const first = stdout.trim().split("\n")[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Install .app onto physical device via devicectl.
 */
export async function installAppOnDevice(
  udid: string,
  appPath: string,
): Promise<void> {
  if (!existsSync(appPath)) {
    throw new Error(`App not found: ${appPath}`);
  }
  const dir = join(runnerWorkDir(), "install-logs");
  mkdirSync(dir, { recursive: true });
  const jsonOut = join(dir, `install-${Date.now()}.json`);
  const INSTALL_TIMEOUT_MS = 5 * 60_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "xcrun",
      [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        udid,
        appPath,
        "--json-output",
        jsonOut,
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
    // Without these, an ENOENT (xcrun off PATH under launchd, Xcode mid-upgrade)
    // emits `error` with no listener and the promise never settles, and a
    // stalled devicectl install hangs the whole daemon tick forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Runner install on ${udid} timed out after ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else {
        let extra = "";
        try {
          extra = readFileSync(jsonOut, "utf8").slice(0, 1500);
        } catch {
          /* ignore */
        }
        finish(
          new Error(
            `Failed to install runner on ${udid} (exit ${code}).\n` +
              `On the phone: Settings → General → VPN & Device Management → Trust developer.\n` +
              `${stderr}\n${extra}`,
          ),
        );
      }
    });
  });
}

/** Full pipeline: wait for device → build → install. */
export async function downloadBuildInstallRunner(
  opts: InstallRunnerOptions = {},
): Promise<InstallRunnerResult> {
  let udid = opts.udid;
  let deviceName = "iPhone";
  if (opts.waitForDevice !== false) {
    const dev = await pollUntilReady({
      udid,
      timeoutMs: opts.waitTimeoutMs ?? 120_000,
    });
    udid = dev.udid;
    deviceName = dev.name;
  } else {
    const devices = await listUsbIphones();
    const dev = udid
      ? devices.find((d) => d.udid === udid)
      : devices.find((d) => d.available);
    if (!dev) {
      throw new Error("No available USB iPhone. Plug in and Trust this computer.");
    }
    udid = dev.udid;
    deviceName = dev.name;
  }

  let appPath = opts.useExistingApp;
  let automationSource: string | undefined;
  let testRunnerPath: string | undefined;
  const plan = planSigning(opts.signing);
  let notes = [...plan.notes];
  if (!appPath) {
    const src = await ensureRunnerSources(opts.repoRoot);
    automationSource = src;
    const built = await buildRunner(src, opts.signing, udid!);
    appPath = built.appPath;
    testRunnerPath = built.testRunnerPath;
    notes = [...notes, ...built.notes];
  }

  await installAppOnDevice(udid!, appPath!);

  if (automationSource) {
    // Xcode's test manager can reject its own first install of a Personal Team
    // test host as untrusted. Preinstall the exact signed host built above.
    await installAppOnDevice(udid!, testRunnerPath!);
    let automation = await launchAutomationRunner(udid!, automationSource);
    let automationState = await waitForAutomationRunnerReady(automation.label, automation.logPath);
    if (automationState === "exited") {
      // launchctl can return from removing the previous xcodebuild job before
      // XCTest has fully released the device test session. One bounded retry
      // avoids reporting a failed install for that normal teardown race.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      automation = await launchAutomationRunner(udid!, automationSource);
      automationState = await waitForAutomationRunnerReady(automation.label, automation.logPath);
    }
    if (automationState !== "ready") {
      const reason = automationState === "exited" ? "exited during startup" : "did not become ready within five minutes";
      throw new Error(`XCTest automation runner ${reason}. See ${automation.logPath}`);
    }
    notes.push(`XCTest automation runner is ready (${automation.label}).`);
  } else {
    notes.push("Existing app used; rebuild normally to install the XCTest automation runner.");
  }

  // The XCTest host is the control server. Launching the base app after it
  // starts would steal foreground focus from the social app mid-command.
  if (!automationSource) {
    try {
      await execFileAsync(
        "xcrun",
        [
          "devicectl",
          "device",
          "process",
          "launch",
          "--device",
          udid!,
          plan.bundleId,
        ],
        { timeout: 30_000 },
      );
    } catch {
      notes.push("Runner installed; launch manually once if control channel is idle.");
    }
  }

  // Persist install record
  const recordPath = join(homedir(), ".heiss", "runner-installs.json");
  mkdirSync(dirname(recordPath), { recursive: true });
  let records: Record<string, unknown> = {};
  if (existsSync(recordPath)) {
    records = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  records[udid!] = {
    udid,
    deviceName,
    appPath,
    bundleId: plan.bundleId,
    installedAt: new Date().toISOString(),
    signingMethod: plan.method,
  };
  writeFileSync(recordPath, JSON.stringify(records, null, 2));

  return {
    ok: true,
    udid: udid!,
    deviceName,
    appPath: appPath!,
    bundleId: plan.bundleId,
    signingMethod: plan.method,
    notes,
    installedAt: new Date().toISOString(),
  };
}

export function automationRunnerLabel(udid: string): string {
  return `so.heiss.automation.${udid.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
}

export function automationLogPath(udid: string): string {
  return join(runnerWorkDir(), "automation-logs", `${udid}.log`);
}

function automationPlistPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** LaunchAgent plist for the long-running XCTest command server. */
export function automationPlistXml(
  label: string,
  programArguments: string[],
  workingDirectory: string,
  logPath: string,
): string {
  const argsXml = programArguments.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("");
  // ThrottleInterval is the crash-loop cap. When CoreDevice degrades, xcodebuild
  // exits ~immediately (EX_SOFTWARE) and a 15s throttle respawned it four times
  // a minute, each opening a fresh CoreDeviceService connection and deepening
  // the wedge. 300s means a genuine one-off crash still recovers within minutes,
  // but a degraded stretch respawns 20x less often — giving CoreDevice room to
  // recover instead of being hammered. A healthy runner starts once and lives
  // its full 12h recycle, so normal operation is unaffected.
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${argsXml}</array><key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>300</integer><key>StandardOutPath</key><string>${xmlEscape(logPath)}</string><key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string></dict></plist>`;
}

export async function waitForAutomationRunnerReady(
  label: string,
  logPath: string,
  timeoutMs = 300_000,
): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, "utf8");
      if (/HEISS_COMMAND_SERVER_READY/.test(log)) return "ready";
      // With KeepAlive the job stays loaded across crash-restarts, so a
      // missing job no longer signals failure — the build/test log does.
      if (/TEST EXECUTE FAILED|Testing failed:|xcodebuild: error/.test(log)) return "exited";
    }
    try {
      await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 5_000 });
    } catch {
      return "exited";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "timeout";
}

/** Unload the automation runner job and remove its LaunchAgent plist. */
export async function stopAutomationRunner(udid: string): Promise<void> {
  const label = automationRunnerLabel(udid);
  const uid = process.getuid?.() ?? 0;
  await execFileAsync("launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 10_000 }).catch(() => undefined);
  // Legacy jobs from older builds were created with `launchctl submit`.
  await execFileAsync("launchctl", ["remove", label], { timeout: 10_000 }).catch(() => undefined);
  rmSync(automationPlistPath(label), { force: true });
}

/**
 * Launch the long-running UI-test command server built by build-for-testing.
 * Installed as a KeepAlive LaunchAgent so it restarts after crashes, the
 * runner's own 12-hour recycle, and Mac reboots.
 */
export async function launchAutomationRunner(
  udid: string,
  sourceDir: string,
): Promise<{ pid: number; logPath: string; label: string }> {
  const derived = join(runnerWorkDir(), "DerivedData");
  mkdirSync(join(runnerWorkDir(), "automation-logs"), { recursive: true });
  const logPath = automationLogPath(udid);
  const label = automationRunnerLabel(udid);
  const uid = process.getuid?.() ?? 0;
  await stopAutomationRunner(udid);
  // Teardown may return while the old xcodebuild is still releasing the
  // device test session. Do not bootstrap under the same label until the
  // previous job is actually gone.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await execFileAsync("launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      break;
    }
  }
  // Rotate the log so readiness checks only ever read this launch's output.
  if (existsSync(logPath)) {
    renameSync(logPath, `${logPath}.previous`);
  }
  const args = [
      "-project", join(sourceDir, "HeissRunner.xcodeproj"),
      "-scheme", RUNNER_APP_NAME,
      "-configuration", "Release",
      "-destination", `platform=iOS,id=${udid}`,
      "-derivedDataPath", derived,
      "test-without-building",
      "-only-testing:HeissRunnerUITests/HeissRunnerUITests/testCommandServer",
  ];
  const plistPath = automationPlistPath(label);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, automationPlistXml(label, ["/usr/bin/xcodebuild", ...args], sourceDir, logPath));
  await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { timeout: 10_000 });
  await execFileAsync("launchctl", ["kickstart", `gui/${uid}/${label}`], { timeout: 10_000 }).catch(() => undefined);
  let pid = 0;
  for (let attempt = 0; attempt < 20 && !pid; attempt++) {
    try {
      const { stdout } = await execFileAsync("launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000 });
      pid = Number(stdout.match(/\bpid = (\d+)/)?.[1] ?? 0);
    } catch { /* job is still starting */ }
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!pid) throw new Error(`Failed to launch XCTest automation job ${label}. See ${logPath}`);
  return { pid, logPath, label };
}

export function isRunnerInstalled(udid: string): boolean {
  const recordPath = join(homedir(), ".heiss", "runner-installs.json");
  if (!existsSync(recordPath)) return false;
  const records = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
    string,
    unknown
  >;
  return Boolean(records[udid]);
}

/**
 * Generate a minimal Xcode project when xcodegen is unavailable.
 * Uses a pbxproj template for a single-target iOS app.
 */
async function generateMinimalXcodeproj(
  sourceDir: string,
  bundleId: string,
): Promise<void> {
  const projDir = join(sourceDir, "HeissRunner.xcodeproj");
  mkdirSync(projDir, { recursive: true });
  // Ensure sources exist
  const appDir = join(sourceDir, "Sources");
  mkdirSync(appDir, { recursive: true });
  if (!existsSync(join(appDir, "App.swift"))) {
    writeFileSync(join(appDir, "App.swift"), SWIFT_APP);
  }
  if (!existsSync(join(appDir, "ControlServer.swift"))) {
    writeFileSync(join(appDir, "ControlServer.swift"), SWIFT_CONTROL);
  }
  if (!existsSync(join(appDir, "Info.plist"))) {
    writeFileSync(join(appDir, "Info.plist"), INFO_PLIST(bundleId));
  }
  writeFileSync(join(projDir, "project.pbxproj"), PBXPROJ(bundleId));
  // shared scheme
  const schemeDir = join(projDir, "xcshareddata", "xcschemes");
  mkdirSync(schemeDir, { recursive: true });
  writeFileSync(join(schemeDir, "HeissRunner.xcscheme"), SCHEME);
}

const SWIFT_APP = `import SwiftUI

@main
struct HeissRunnerApp: App {
    @StateObject private var server = ControlServer.shared
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("Heiss Runner").font(.largeTitle.bold())
                Text(server.statusText).font(.body).foregroundStyle(.secondary)
                Text("The Mac launches the signed XCTest automation runner.")
                    .font(.caption).multilineTextAlignment(.center).padding()
            }
            .padding()
            .onAppear { server.start() }
        }
    }
}
`;

const SWIFT_CONTROL = `import Foundation
import UIKit

/// Local control channel: watches Documents/inbox for command JSON from the Mac (USB file drop).
final class ControlServer: ObservableObject {
    static let shared = ControlServer()
    @Published var statusText = "Starting…"
    private var timer: Timer?

    func start() {
        statusText = "Ready — waiting for Mac commands"
        let inbox = Self.inboxURL()
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.drainInbox()
        }
    }

    private func drainInbox() {
        let inbox = Self.inboxURL()
        guard let files = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let action = cmd["action"] as? String ?? "unknown"
            let result = Self.perform(action: action, cmd: cmd)
            let out = Self.outboxURL().appendingPathComponent(file.lastPathComponent)
            try? FileManager.default.createDirectory(at: Self.outboxURL(), withIntermediateDirectories: true)
            if let outData = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]) {
                try? outData.write(to: out)
            }
            try? FileManager.default.removeItem(at: file)
            DispatchQueue.main.async {
                self.statusText = "Last: \\(action) → \\(result["detail"] as? String ?? "")"
            }
        }
    }

    static func perform(action: String, cmd: [String: Any]) -> [String: Any] {
        // Human-like gestures via coordinate taps when host supplies points.
        // Real social-app navigation uses on-device UI; never unofficial platform APIs.
        if action.contains("scroll") || action.contains("swipe") {
            return ["ok": false, "executed": false, "detail": "XCTest automation runner required for \\(action)"]
        }
        if action.contains("tap") || action.contains("like") || action.contains("follow")
            || action.contains("search") || action.contains("post") || action.contains("warmup") {
            return ["ok": false, "executed": false, "detail": "XCTest automation runner required for \\(action)"]
        }
        if action == "ping" {
            return ["ok": true, "detail": "pong", "ts": ISO8601DateFormatter().string(from: Date())]
        }
        return ["ok": true, "detail": "ack \\(action)"]
    }

    static func inboxURL() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("inbox", isDirectory: true)
    }
    static func outboxURL() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("outbox", isDirectory: true)
    }
}
`;

function INFO_PLIST(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Heiss Runner</string>
  <key>CFBundleExecutable</key><string>HeissRunner</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>HeissRunner</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchScreen</key><dict/>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
  </array>
</dict>
</plist>
`;
}

// Minimal pbxproj — single iOS app target
function PBXPROJ(bundleId: string): string {
  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {};
	objectVersion = 56;
	objects = {
		A10000000000000000000001 /* App.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App.swift; sourceTree = "<group>"; };
		A10000000000000000000002 /* ControlServer.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ControlServer.swift; sourceTree = "<group>"; };
		A10000000000000000000003 /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
		A10000000000000000000010 /* HeissRunner.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = HeissRunner.app; sourceTree = BUILT_PRODUCTS_DIR; };
		A10000000000000000000020 /* Sources */ = {isa = PBXGroup; children = (A10000000000000000000001, A10000000000000000000002, A10000000000000000000003); path = Sources; sourceTree = "<group>"; };
		A10000000000000000000021 /* Products */ = {isa = PBXGroup; children = (A10000000000000000000010); name = Products; sourceTree = "<group>"; };
		A10000000000000000000022 = {isa = PBXGroup; children = (A10000000000000000000020, A10000000000000000000021); sourceTree = "<group>"; };
		A10000000000000000000030 /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A10000000000000000000040, A10000000000000000000041); runOnlyForDeploymentPostprocessing = 0; };
		A10000000000000000000040 /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10000000000000000000001; };
		A10000000000000000000041 /* ControlServer.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10000000000000000000002; };
		A10000000000000000000050 /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		A10000000000000000000060 /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		A10000000000000000000070 /* HeissRunner */ = {isa = PBXNativeTarget; buildConfigurationList = A10000000000000000000090; buildPhases = (A10000000000000000000030, A10000000000000000000050, A10000000000000000000060); buildRules = (); dependencies = (); name = HeissRunner; productName = HeissRunner; productReference = A10000000000000000000010; productType = "com.apple.product-type.application"; };
		A10000000000000000000080 /* Project object */ = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1500; LastUpgradeCheck = 1500;}; buildConfigurationList = A10000000000000000000091; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = A10000000000000000000022; productRefGroup = A10000000000000000000021; projectDirPath = ""; projectRoot = ""; targets = (A10000000000000000000070); };
		A100000000000000000000A1 /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = dwarf; GCC_DYNAMIC_NO_PIC = NO; IPHONEOS_DEPLOYMENT_TARGET = 16.0; ONLY_ACTIVE_ARCH = YES; SDKROOT = iphoneos; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone";}; name = Debug; };
		A100000000000000000000A2 /* Release */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; IPHONEOS_DEPLOYMENT_TARGET = 16.0; SDKROOT = iphoneos; SWIFT_COMPILATION_MODE = wholemodule; VALIDATE_PRODUCT = YES;}; name = Release; };
		A100000000000000000000B1 /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_TEAM = ""; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = Sources/Info.plist; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks"); MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleId}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1;}; name = Debug; };
		A100000000000000000000B2 /* Release */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_TEAM = ""; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = Sources/Info.plist; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks"); MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleId}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1;}; name = Release; };
		A10000000000000000000090 = {isa = XCConfigurationList; buildConfigurations = (A100000000000000000000B1, A100000000000000000000B2); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
		A10000000000000000000091 = {isa = XCConfigurationList; buildConfigurations = (A100000000000000000000A1, A100000000000000000000A2); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
	};
	rootObject = A10000000000000000000080 /* Project object */;
}
`;
}

const SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1500" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000070" BuildableName="HeissRunner.app" BlueprintName="HeissRunner" ReferencedContainer="container:HeissRunner.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <LaunchAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000070" BuildableName="HeissRunner.app" BlueprintName="HeissRunner" ReferencedContainer="container:HeissRunner.xcodeproj"/>
    </BuildableProductRunnable>
  </LaunchAction>
</Scheme>
`;
