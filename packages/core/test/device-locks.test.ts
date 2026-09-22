import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_LOCK_MAX_AGE_MS,
  JsonStore,
  emptyState,
  normalizeDeviceLock,
  staleDeviceLocks,
} from "../src/index.js";

const now = "2026-09-22T14:39:00.000Z";
const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString();
const alive = () => true;
const dead = () => false;

describe("device locks", () => {
  it("keeps a lock whose owner is alive and recent", () => {
    const devices = { d1: { holder: "curated-1", pid: 42, acquiredAt: ago(60_000) } };
    assert.deepEqual(staleDeviceLocks(devices, { nowIso: now, pidIsAlive: alive }), []);
  });

  it("reclaims one whose owner died, one held too long, and one from a dead session", () => {
    const devices = {
      d1: { holder: "curated-1", pid: 42, acquiredAt: ago(60_000) },
      d2: { holder: "curated-2", pid: 43, acquiredAt: ago(DEVICE_LOCK_MAX_AGE_MS + 60_000) },
      d3: { holder: "session-9", pid: 44, acquiredAt: ago(60_000) },
    };
    const stale = staleDeviceLocks(devices, {
      nowIso: now,
      pidIsAlive: (pid) => pid !== 42,
      orphanedHolders: new Set(["session-9"]),
    });
    assert.deepEqual(stale.map((s) => s.deviceId).sort(), ["d1", "d2", "d3"]);
    assert.match(stale.find((s) => s.deviceId === "d1")!.reason, /owner pid 42 is gone/);
    assert.match(stale.find((s) => s.deviceId === "d2")!.reason, /held 31 minutes/);
    assert.match(stale.find((s) => s.deviceId === "d3")!.reason, /its session died/);
  });

  it("treats a legacy lock with no recorded owner as reclaimable", () => {
    // Exactly what blocked the farm on 2026-09-22.
    const devices = { d1: "curated-616098fb-7b53-42c7-8be7-9dfce0796766" };
    assert.deepEqual(normalizeDeviceLock(devices.d1), { holder: devices.d1, pid: 0, acquiredAt: "" });
    const stale = staleDeviceLocks(devices, { nowIso: now, pidIsAlive: alive });
    assert.equal(stale.length, 1);
    assert.match(stale[0]!.reason, /no recorded owner/);
  });

  it("clears a stranded legacy lock when the store loads, and reports it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "heiss-locks-")), "farm.json");
    const state = emptyState();
    state.devices.push({ id: "d1", name: "iPhone", udid: "U1", online: true, createdAt: now });
    state.locks = { devices: { d1: "curated-616098fb" }, content: {} };
    writeFileSync(path, JSON.stringify(state));

    const store = new JsonStore(path);
    assert.equal(store.locks.isDeviceLocked("d1"), false, "the device is usable again");
    assert.deepEqual(store.reclaimedDeviceLocks.map((l) => l.deviceId), ["d1"]);
    store.save();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).locks.devices, {});
  });

  it("records the owner when a lock is taken, so it can be judged later", () => {
    const path = join(mkdtempSync(join(tmpdir(), "heiss-locks-")), "farm.json");
    const store = new JsonStore(path);
    store.locks.acquireDevice("d1", "session-1");
    store.save();
    const lock = normalizeDeviceLock(JSON.parse(readFileSync(path, "utf8")).locks.devices.d1);
    assert.equal(lock.holder, "session-1");
    assert.equal(lock.pid, process.pid);
    assert.ok(Date.parse(lock.acquiredAt) > 0);
    // A live, fresh lock still blocks a second holder.
    assert.throws(() => store.locks.acquireDevice("d1", "session-2"), /already locked/);
  });
});
