/**
 * Cross-process lock-file primitives shared by the farm store's write lock and
 * the device package's runner build lock.
 *
 * Both hazards below were found by the 2026-09-14 audit and reproduced with
 * racing processes: a lock written after O_EXCL creation can be read empty and
 * judged stale, and check-then-delete reclaim lets a slow reclaimer delete a
 * lock a faster one just created.
 */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export interface LockRecord {
  pid: number;
  /** Holder process start time (epoch ms) — distinguishes a reused PID. */
  processStartedAt: number;
  acquiredAt: number;
  purpose: string;
}

/** Live process start (epoch ms), `null` when gone, "unknown" when unreadable. */
export type ProcessProbe = (pid: number) => number | null | "unknown";

export function currentProcessStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

export function newLockRecord(purpose: string): LockRecord {
  return { pid: process.pid, processStartedAt: currentProcessStartedAt(), acquiredAt: Date.now(), purpose };
}

/** Cheap liveness only: enough when the lock's max age is too short for PID reuse. */
export const probeProcessAlive: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return "unknown";
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "unknown" : null;
  }
};

export function isLockStale(
  record: LockRecord | null,
  now: number,
  maxAgeMs: number,
  probe: ProcessProbe,
): boolean {
  if (!record || !Number.isInteger(record.pid) || !Number.isFinite(record.acquiredAt)) return true;
  if (now - record.acquiredAt > maxAgeMs) return true;
  const started = probe(record.pid);
  if (started === null) return true;
  // ps reports whole seconds; a start time far from the recorded one is a reused PID.
  if (started !== "unknown" && Math.abs(started - record.processStartedAt) > 5_000) return true;
  return false;
}

export function readLockRecord(path: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Create the lock atomically with its full content: write privately, then
 * hard-link into place. link() fails when the lock exists and never exposes a
 * half-written file.
 */
export function tryCreateLockFile(path: string, record: LockRecord): boolean {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* already removed */ }
  }
}

/** A reclaim is a sub-millisecond critical section; a guard this old belongs
 *  to a reclaimer that died inside it. */
const RECLAIM_GUARD_STALE_MS = 30_000;

function withReclaimGuard(path: string, fn: () => void): boolean {
  const guard = `${path}.reclaim`;
  const take = (): boolean => {
    try {
      mkdirSync(guard);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!take()) {
    let age = 0;
    try { age = Date.now() - statSync(guard).mtimeMs; } catch { /* just released */ }
    if (age <= RECLAIM_GUARD_STALE_MS) return false;
    try { rmdirSync(guard); } catch { /* another reclaimer removed it */ }
    if (!take()) return false;
  }
  try {
    fn();
    return true;
  } finally {
    try { rmdirSync(guard); } catch { /* already removed */ }
  }
}

/**
 * Replace a stale lock with `record`. Runs under an atomic mkdir guard and
 * re-judges the lock inside it, so two reclaimers of one stale lock cannot
 * delete each other's fresh lock. Returns true when `record` now holds it.
 */
export function reclaimStaleLock(
  path: string,
  record: LockRecord,
  judgedStale: LockRecord | null,
  isStale: (current: LockRecord | null) => boolean,
): boolean {
  let acquired = false;
  withReclaimGuard(path, () => {
    const current = readLockRecord(path);
    if (current && JSON.stringify(current) !== JSON.stringify(judgedStale) && !isStale(current)) return;
    try { unlinkSync(path); } catch { /* already removed */ }
    acquired = tryCreateLockFile(path, record);
  });
  return acquired;
}

/** Remove the lock only if `record` still owns it. */
export function releaseLockFile(path: string, record: LockRecord): void {
  const current = readLockRecord(path);
  if (current && current.pid === record.pid && current.acquiredAt === record.acquiredAt) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
}
