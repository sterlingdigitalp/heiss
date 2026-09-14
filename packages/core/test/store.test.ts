import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, StoreConflictError, emptyState, pruneActivity, pruneSessions } from "../src/index.js";

describe("activity retention", () => {
  it("prunes activity beyond the retention window but keeps everything inside it", () => {
    const state = emptyState();
    const now = "2026-07-18T00:00:00.000Z";
    const day = (n: number) => new Date(Date.parse(now) - n * 86_400_000).toISOString();
    state.activity.push(
      { id: "recent", at: day(1), kind: "action", message: "yesterday" },
      { id: "inside", at: day(44), kind: "action", message: "just inside the window" },
      { id: "old", at: day(60), kind: "action", message: "well outside" },
      { id: "ancient", at: day(400), kind: "action", message: "a year ago" },
      { id: "unparseable", at: "not-a-date", kind: "action", message: "kept, not silently dropped" },
    );
    const removed = pruneActivity(state, now);
    assert.equal(removed, 2);
    assert.deepEqual(
      state.activity.map((event) => event.id).sort(),
      ["inside", "recent", "unparseable"],
    );
  });
});

describe("farm state persistence", () => {
  it("writes atomically and refuses stale cross-process overwrites", () => {
    const path = join(mkdtempSync(join(tmpdir(), "heiss-store-")), "farm.json");
    const initial = new JsonStore(path);
    initial.save();
    const first = new JsonStore(path);
    const stale = new JsonStore(path);
    first.pushActivity({ kind: "first", message: "first writer" });
    first.save();
    stale.pushActivity({ kind: "stale", message: "must not overwrite" });
    assert.throws(() => stale.save(), StoreConflictError);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(persisted.activity.length, 1);
    assert.equal(persisted.activity[0].kind, "first");
    assert.equal(persisted.revision, 2);
  });
});

describe("session pruning", () => {
  // Activity was pruned at 45 days; sessions never were. farm.json grew to
  // 4.4 MB / 278 sessions by 2026-08-19, and the orchestrator rewrites the
  // whole document after every device step.
  const now = "2026-08-19T12:00:00.000Z";
  const old = "2026-05-01T12:00:00.000Z"; // >45 days before now
  const session = (over: Record<string, unknown>) => ({
    id: "s", accountId: "a", deviceId: "d", kind: "warmup",
    status: "completed", startedAt: old, updatedAt: old,
    checkpoint: { stepIndex: 0, posted: false }, activityLog: [], ...over,
  });

  it("drops terminal sessions past the retention window", () => {
    const state = { sessions: [session({ id: "old-done" })], activity: [], locks: { devices: {}, content: {} } };
    const removed = pruneSessions(state as never, now);
    assert.equal(removed, 1);
    assert.equal(state.sessions.length, 0);
  });

  it("keeps recent terminal sessions", () => {
    const state = { sessions: [session({ id: "fresh", updatedAt: now })], activity: [], locks: { devices: {}, content: {} } };
    assert.equal(pruneSessions(state as never, now), 0);
  });

  it("never prunes resumable work, however old", () => {
    const state = {
      sessions: [session({ id: "cp", status: "checkpointed" }), session({ id: "run", status: "running" })],
      activity: [], locks: { devices: {}, content: {} },
    };
    assert.equal(pruneSessions(state as never, now), 0);
    assert.equal(state.sessions.length, 2);
  });

  it("never prunes a session that still holds a lock", () => {
    // Pruning a lock holder would strand the device with no way to identify it.
    const state = {
      sessions: [session({ id: "holder" })],
      activity: [], locks: { devices: { "device-1": "holder" }, content: {} },
    };
    assert.equal(pruneSessions(state as never, now), 0);
  });

  it("keeps a session with an unparseable timestamp rather than dropping it", () => {
    const state = { sessions: [session({ id: "weird", updatedAt: "not-a-date" })], activity: [], locks: { devices: {}, content: {} } };
    assert.equal(pruneSessions(state as never, now), 0);
  });
});

describe("legacy schedule backfill", () => {
  const legacyFarm = () => {
    const path = join(mkdtempSync(join(tmpdir(), "heiss-backfill-")), "farm.json");
    const state = emptyState() as ReturnType<typeof emptyState> & { settings: { scheduleBackfillVersion?: number } };
    delete state.settings.scheduleBackfillVersion;
    state.accounts.push({
      id: "x1", deviceId: "d1", platform: "x", handle: "@legacy",
      stage: "fresh", trustScore: 0, searchTerms: [], createdAt: "2026-07-01T00:00:00.000Z",
    });
    writeFileSync(path, JSON.stringify(state));
    return path;
  };

  it("backfills a legacy account once", () => {
    const store = new JsonStore(legacyFarm());
    assert.equal(store.state.warmupSchedules.filter((s) => s.accountId === "x1").length, 1);
    assert.equal(store.state.slots.filter((s) => s.accountId === "x1").length, 1);
    assert.equal(store.state.settings.scheduleBackfillVersion, 1);
  });

  it("keeps removed warmup schedules and slots removed across reloads", () => {
    const path = legacyFarm();
    const store = new JsonStore(path);
    store.state.warmupSchedules = store.state.warmupSchedules.filter((s) => s.accountId !== "x1");
    store.state.slots = store.state.slots.filter((s) => s.accountId !== "x1");
    store.save();

    const reopened = new JsonStore(path);
    assert.deepEqual(reopened.state.warmupSchedules.filter((s) => s.accountId === "x1"), []);
    assert.deepEqual(reopened.state.slots.filter((s) => s.accountId === "x1"), []);
  });
});
