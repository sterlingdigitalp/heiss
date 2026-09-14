/**
 * Name the known ways the automation runner fails, from ping details, thrown
 * install errors, and xcodebuild logs. Every pattern here was seen in
 * ~/.heiss/runner-build logs or a recorded incident — add to it from evidence,
 * not guesses.
 *
 * `needsHuman` causes cannot be fixed by relaunching, reinstalling, or
 * restarting CoreDevice, so the supervisor stops and says exactly what to do
 * instead of cycling a repair that cannot work. Every other cause is advisory:
 * it names the problem but the normal repair ladder still runs.
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

export type RunnerFailureCause =
  | "device_locked"
  | "developer_mode_off"
  | "developer_certificate_untrusted"
  | "xcode_account_missing"
  | "xcode_team_mismatch"
  | "device_storage_full"
  | "device_unreachable"
  | "install_failed";

export interface RunnerDiagnosis {
  cause: RunnerFailureCause;
  needsHuman: boolean;
  /** What to do, phrased for a desktop notification. */
  action: string;
}

const RULES: Array<{ cause: RunnerFailureCause; needsHuman: boolean; pattern: RegExp; action: string }> = [
  // Most specific first: a storage or trust failure also contains the generic
  // "Failed to install" / "locked" wording further down the list.
  {
    cause: "developer_mode_off", needsHuman: true, pattern: /developer mode/i,
    action: "Turn on Developer Mode (Settings → Privacy & Security → Developer Mode) and restart the phone.",
  },
  {
    cause: "developer_certificate_untrusted", needsHuman: true,
    pattern: /not been explicitly trusted|Developer App Certificate is not trusted|denied by service delegate \(SBMainWorkspace\) for reason: Security/i,
    action: "Trust the developer certificate on the phone: Settings → General → VPN & Device Management.",
  },
  {
    cause: "xcode_team_mismatch", needsHuman: true, pattern: /No Account for Team/i,
    action: "The Xcode account does not own the signing team — switch the team, do not re-sign in.",
  },
  {
    cause: "xcode_account_missing", needsHuman: true, pattern: /\bNo Accounts\b/,
    action: "Xcode cannot reach the signing account from the command line. Open Xcode once (unlocks the keychain), then retry.",
  },
  {
    cause: "device_storage_full", needsHuman: true, pattern: /No space left on device|\bENOSPC\b/i,
    action: "The phone is out of storage. Free space (or back up + restore to clear System Data) before reinstalling.",
  },
  {
    cause: "device_locked", needsHuman: true, pattern: /locked|passcode|\bunlock\b/i,
    action: "Unlock the phone and leave it connected.",
  },
  // No rule for "Device is busy (Connecting…)": xcodebuild prints it in its
  // ineligible-destinations list even on runs that go on to succeed. When it
  // is the real problem, the failure is the destination error below. The same
  // goes for "Timed out waiting for all destinations", a warning on good runs.
  {
    cause: "device_unreachable", needsHuman: false,
    pattern: /Unable to find a destination matching|tunnelState\W+disconnected/i,
    action: "Xcode cannot see the phone. If Finder can, open Xcode → Devices and Simulators once to bring up the CoreDevice tunnel, then quit it.",
  },
  {
    cause: "install_failed", needsHuman: false,
    pattern: /Failed to install the app on the device|Failed to stream the app asset|IXRemoteErrorDomain/i,
    action: "Installing the runner failed; check free storage on the phone if it keeps happening.",
  },
];

export function diagnoseRunnerFailure(evidence: string): RunnerDiagnosis | undefined {
  const rule = RULES.find((candidate) => candidate.pattern.test(evidence));
  return rule && { cause: rule.cause, needsHuman: rule.needsHuman, action: rule.action };
}

/** Last `bytes` of a log file, or "" when unreadable. */
function tail(path: string, bytes = 64_000): string {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The text to diagnose: the messages themselves plus the tail of any log they
 * point at ("see /path/to.log"), since xcodebuild's real reason lives there.
 */
export function runnerFailureEvidence(...messages: Array<string | undefined>): string {
  const text = messages.filter(Boolean).join("\n");
  const logs = [...text.matchAll(/\b[Ss]ee (\/\S+?\.log)\b/g)].map((match) => tail(match[1]!));
  return [text, ...logs].join("\n");
}
