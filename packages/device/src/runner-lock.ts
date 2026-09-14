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
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Longer than the worst legitimate pipeline (device wait + 600s build +
 *  installs + two 300s readiness waits); past this the lock is stale even if
 *  its PID is alive, which bounds PID reuse and a wedged holder. */
export const RUNNER_LOCK_MAX_AGE_MS = 60 * 60_000;

export interface RunnerLockRecord {
  pid: number;
  /** Holder process start time (epoch ms) — distinguishes a reused PID. */
  processStartedAt: number;
  acquiredAt: number;
  purpose: string;
}

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

function ownProcessStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/** Start time of a live PID via ps, or null when the PID is gone. */
function processStartedAt(pid: number): number | null | "unknown" {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
    const parsed = Date.parse(out.trim());
    return Number.isFinite(parsed) ? parsed : "unknown";
  } catch {
    return "unknown";
  }
}

export function isRunnerLockStale(
  record: RunnerLockRecord | null,
  now: number,
  probe: (pid: number) => number | null | "unknown" = processStartedAt,
): boolean {
  if (!record || !Number.isInteger(record.pid) || !Number.isFinite(record.acquiredAt)) return true;
  if (now - record.acquiredAt > RUNNER_LOCK_MAX_AGE_MS) return true;
  const started = probe(record.pid);
  if (started === null) return true;
  // ps reports whole seconds; a start time far from the recorded one is a reused PID.
  if (started !== "unknown" && Math.abs(started - record.processStartedAt) > 5_000) return true;
  return false;
}

function readRecord(path: string): RunnerLockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunnerLockRecord;
  } catch {
    return null;
  }
}

function tryCreate(path: string, record: RunnerLockRecord): boolean {
  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
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
  const record: RunnerLockRecord = {
    pid: process.pid,
    processStartedAt: ownProcessStartedAt(),
    acquiredAt: Date.now(),
    purpose,
  };
  if (!tryCreate(path, record)) {
    const existing = readRecord(path);
    if (!isRunnerLockStale(existing, Date.now())) throw new RunnerBusyError(existing!);
    // Re-read before removing so we never delete a lock someone else just took.
    if (JSON.stringify(readRecord(path)) === JSON.stringify(existing)) {
      try { unlinkSync(path); } catch { /* already removed */ }
    }
    if (!tryCreate(path, record)) {
      throw new RunnerBusyError(readRecord(path) ?? existing ?? record);
    }
  }

  const release = () => {
    const current = readRecord(path);
    if (current && current.pid === record.pid && current.acquiredAt === record.acquiredAt) {
      try { unlinkSync(path); } catch { /* already removed */ }
    }
  };
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
