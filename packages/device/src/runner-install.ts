/**
 * Download (scaffold/sync), build, sign, and install HeissRunner on a physical iPhone.
 */
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
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
): Promise<{ appPath: string; notes: string[] }> {
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
    "generic/platform=iOS",
    "-derivedDataPath",
    derived,
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
    throw new Error(
      `xcodebuild failed for HeissRunner.\n` +
        `Ensure Xcode is installed, Apple ID Team is set (HEISS_TEAM_ID), and a real iOS SDK is available.\n` +
        `${err.stderr?.slice(-2000) ?? err.stdout?.slice(-2000) ?? err.message}`,
    );
  }

  const appPath = findBuiltApp(derived);
  if (!appPath) {
    throw new Error(`Build succeeded but HeissRunner.app not found under ${derived}`);
  }
  return { appPath, notes: plan.notes };
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
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        let extra = "";
        try {
          extra = readFileSync(jsonOut, "utf8").slice(0, 1500);
        } catch {
          /* ignore */
        }
        reject(
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
  const plan = planSigning(opts.signing);
  let notes = [...plan.notes];
  if (!appPath) {
    const src = await ensureRunnerSources(opts.repoRoot);
    automationSource = src;
    const built = await buildRunner(src, opts.signing);
    appPath = built.appPath;
    notes = [...notes, ...built.notes];
  }

  await installAppOnDevice(udid!, appPath!);

  if (automationSource) {
    const automation = launchAutomationRunner(udid!, automationSource);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      process.kill(automation.pid, 0);
    } catch {
      throw new Error(`XCTest automation runner exited during startup. See ${automation.logPath}`);
    }
    notes.push(`XCTest automation runner started (pid ${automation.pid}).`);
  } else {
    notes.push("Existing app used; rebuild normally to install the XCTest automation runner.");
  }

  // Launch runner so it can accept control commands
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

/** Launch the long-running UI-test command server built by build-for-testing. */
export function launchAutomationRunner(
  udid: string,
  sourceDir: string,
): { pid: number; logPath: string } {
  const derived = join(runnerWorkDir(), "DerivedData");
  const logs = join(runnerWorkDir(), "automation-logs");
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, `${udid}-${Date.now()}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(
    "xcodebuild",
    [
      "-project", join(sourceDir, "HeissRunner.xcodeproj"),
      "-scheme", RUNNER_APP_NAME,
      "-destination", `platform=iOS,id=${udid}`,
      "-derivedDataPath", derived,
      "test-without-building",
      "-only-testing:HeissRunnerUITests/HeissRunnerUITests/testCommandServer",
    ],
    { cwd: sourceDir, detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  child.unref();
  if (!child.pid) throw new Error("Failed to launch XCTest automation runner");
  return { pid: child.pid, logPath };
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
