import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, StoreConflictError, emptyState, pruneActivity } from "../src/index.js";

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
