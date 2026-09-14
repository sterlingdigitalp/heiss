/**
 * Exclusive lock over the shared runner build directory.
 *
 * Every device builds from the same ~/.heiss/runner-build (sources copy +
 * DerivedData), and `runner install` runs in-process rather than through the
 * daemon, so a manual install can race the daemon's relaunch/re-sign and
 * delete sources mid-build. The loser of the race gives up with a clear
 * message — it never kills the holder, because killing an in-flight build or
 * install is worse than waiting for the daemon's next cooldown.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isLockStale,
  newLockRecord,
  probeProcessAlive,
  readLockRecord,
  reclaimStaleLock,
  releaseLockFile,
  tryCreateLockFile,
  type LockRecord,
  type ProcessProbe,
} from "@heiss/core";

/** Longer than the worst legitimate pipeline (device wait + 600s build +
 *  installs + two 300s readiness waits); past this the lock is stale even if
 *  its PID is alive, which bounds PID reuse and a wedged holder. */
export const RUNNER_LOCK_MAX_AGE_MS = 60 * 60_000;

export type RunnerLockRecord = LockRecord;

export class RunnerBusyError extends Error {
  constructor(readonly holder: RunnerLockRecord) {
    super(
      `HeissRunner build directory is busy: ${holder.purpose} (pid ${holder.pid}, ` +
        `started ${Math.round((Date.now() - holder.acquiredAt) / 1000)}s ago). ` +
        "Wait for it to finish and retry.",
    );
    this.name = "RunnerBusyError";
  }
}

export function runnerLockPath(): string {
  return join(homedir(), ".heiss", "runner-build.lock");
}

/** An hour is long enough for PID reuse, so compare process start times via ps. */
const probeProcessStart: ProcessProbe = (pid) => {
  if (probeProcessAlive(pid) === null) return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
    const parsed = Date.parse(out.trim());
    return Number.isFinite(parsed) ? parsed : "unknown";
  } catch {
    return "unknown";
  }
};

export function isRunnerLockStale(
  record: RunnerLockRecord | null,
  now: number,
  probe: ProcessProbe = probeProcessStart,
): boolean {
  return isLockStale(record, now, RUNNER_LOCK_MAX_AGE_MS, probe);
}

/**
 * Run `fn` holding the runner build lock. Throws RunnerBusyError when a live
 * holder exists (including another operation in this same process).
 */
export async function withRunnerBuildLock<T>(
  purpose: string,
  fn: () => Promise<T>,
  path: string = runnerLockPath(),
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const record = newLockRecord(purpose);
  if (!tryCreateLockFile(path, record)) {
    const existing = readLockRecord(path);
    if (!isRunnerLockStale(existing, Date.now())) throw new RunnerBusyError(existing!);
    const stale = (current: RunnerLockRecord | null) => isRunnerLockStale(current, Date.now());
    if (!reclaimStaleLock(path, record, existing, stale)) {
      throw new RunnerBusyError(readLockRecord(path) ?? existing ?? record);
    }
  }

  const release = () => releaseLockFile(path, record);
  // `finally` does not run on process.exit (e.g. the daemon's tick watchdog).
  // No SIGTERM handler: adding one would suppress default termination; a
  // signal-killed holder is reclaimed by the dead-PID check instead.
  process.once("exit", release);
  try {
    return await fn();
  } finally {
    process.removeListener("exit", release);
    release();
  }
}
