import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, StoreConflictError } from "../src/index.js";

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
