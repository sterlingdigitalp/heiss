/** In-process + serializable locks for devices and content (no double-assign). */

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockSnapshot {
  /** Strings are legacy locks written before ownership was recorded. */
  devices: Record<string, DeviceLockRecord | string>;
  content: Record<string, string>;
}

export class ResourceLocks {
  private devices = new Map<string, DeviceLockRecord>();
  private content = new Map<string, string>();

  acquireDevice(deviceId: string, sessionId: string): void {
    const holder = this.devices.get(deviceId);
    if (holder && holder.holder !== sessionId) {
      throw new LockError(`Device ${deviceId} already locked by session ${holder.holder}`);
    }
    // Record who holds it and since when, so a lock left by a dead holder can
    // be told apart from one that is genuinely in use.
    this.devices.set(deviceId, {
      holder: sessionId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
  }

  releaseDevice(deviceId: string, sessionId: string): void {
    const holder = this.devices.get(deviceId);
    if (holder?.holder === sessionId) {
      this.devices.delete(deviceId);
    }
  }

  acquireContent(queueItemId: string, sessionId: string): void {
    const holder = this.content.get(queueItemId);
    if (holder && holder !== sessionId) {
      throw new LockError(
        `Content ${queueItemId} already assigned to session ${holder}`,
      );
    }
    this.content.set(queueItemId, sessionId);
  }

  releaseContent(queueItemId: string, sessionId: string): void {
    const holder = this.content.get(queueItemId);
    if (holder === sessionId) {
      this.content.delete(queueItemId);
    }
  }

  isDeviceLocked(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  isContentLocked(queueItemId: string): boolean {
    return this.content.has(queueItemId);
  }

  holderOfDevice(deviceId: string): string | undefined {
    return this.devices.get(deviceId)?.holder;
  }

  deviceLock(deviceId: string): DeviceLockRecord | undefined {
    return this.devices.get(deviceId);
  }

  /** Drop a lock whoever holds it — for reclaiming one left by a dead owner. */
  forceReleaseDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  holderOfContent(queueItemId: string): string | undefined {
    return this.content.get(queueItemId);
  }

  snapshot(): LockSnapshot {
    return {
      devices: Object.fromEntries(this.devices),
      content: Object.fromEntries(this.content),
    };
  }

  restore(snapshot: LockSnapshot): void {
    this.devices = new Map(Object.entries(snapshot.devices)
      .map(([deviceId, value]) => [deviceId, normalizeDeviceLock(value)]));
    this.content = new Map(Object.entries(snapshot.content));
  }

  clear(): void {
    this.devices.clear();
    this.content.clear();
  }
}

/**
 * Who holds a device lock and since when.
 *
 * A device lock used to be just a holder id, so nothing could tell a live
 * holder from a dead one. A curated engagement that died with the lock held
 * therefore blocked the farm permanently: every later tick reported
 * `device_busy`, warmups queued behind it, and because that reads as a normal
 * outcome rather than an error nothing escalated. Seen 2026-08-07 and again
 * 2026-09-22, where one stale lock cost the whole morning.
 */
export interface DeviceLockRecord {
  holder: string;
  /** Process that took it; 0 when unknown (a lock written before this field). */
  pid: number;
  acquiredAt: string;
}

/** Longer than any legitimate hold: a batched session's 15-minute ceiling,
 *  plus the runner relaunch and repair that can follow it. */
export const DEVICE_LOCK_MAX_AGE_MS = 30 * 60_000;

export function normalizeDeviceLock(value: DeviceLockRecord | string): DeviceLockRecord {
  return typeof value === "string"
    ? { holder: value, pid: 0, acquiredAt: "" }
    : value;
}

/**
 * Device locks that no longer protect anything: the holder process is gone,
 * the hold outlived any real session, or the lock predates ownership tracking.
 */
export function staleDeviceLocks(
  devices: Record<string, DeviceLockRecord | string>,
  opts: {
    nowIso: string;
    pidIsAlive: (pid: number) => boolean;
    orphanedHolders?: Set<string>;
    maxAgeMs?: number;
  },
): Array<{ deviceId: string; holder: string; reason: string }> {
  const stale: Array<{ deviceId: string; holder: string; reason: string }> = [];
  for (const [deviceId, raw] of Object.entries(devices)) {
    const lock = normalizeDeviceLock(raw);
    if (opts.orphanedHolders?.has(lock.holder)) {
      stale.push({ deviceId, holder: lock.holder, reason: "its session died" });
      continue;
    }
    if (!lock.acquiredAt || lock.pid === 0) {
      // Written before locks recorded ownership — it cannot be verified, and
      // leaving it would block the device forever.
      stale.push({ deviceId, holder: lock.holder, reason: "no recorded owner" });
      continue;
    }
    if (!opts.pidIsAlive(lock.pid)) {
      stale.push({ deviceId, holder: lock.holder, reason: `owner pid ${lock.pid} is gone` });
      continue;
    }
    const age = Date.parse(opts.nowIso) - Date.parse(lock.acquiredAt);
    if (Number.isFinite(age) && age > (opts.maxAgeMs ?? DEVICE_LOCK_MAX_AGE_MS)) {
      stale.push({ deviceId, holder: lock.holder, reason: `held ${Math.round(age / 60_000)} minutes` });
    }
  }
  return stale;
}
