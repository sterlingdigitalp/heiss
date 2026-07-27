import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTargetHandle,
  targetHandleKey,
  validateTargetHandle,
  curatedTargetsFor,
  activeCuratedTargetsFor,
  checkCuratedTargetAddition,
} from "../src/targets.js";
import { MAX_CURATED_TARGETS_PER_ACCOUNT } from "../src/types.js";
import type { CuratedTarget } from "../src/types.js";

function target(partial: Partial<CuratedTarget> & { handle: string }): CuratedTarget {
  return {
    id: partial.handle,
    accountId: partial.accountId ?? "persona-1",
    handle: partial.handle,
    active: partial.active ?? true,
    addedAt: partial.addedAt ?? "2026-07-27T00:00:00.000Z",
    engagedCount: partial.engagedCount ?? 0,
    ...partial,
  };
}

describe("curated target handles", () => {
  it("normalizes to exactly one leading @", () => {
    assert.equal(normalizeTargetHandle("naval"), "@naval");
    assert.equal(normalizeTargetHandle("@naval"), "@naval");
    assert.equal(normalizeTargetHandle("  @@naval  "), "@naval");
  });

  it("compares case-insensitively so @Naval and @naval are one person", () => {
    assert.equal(targetHandleKey("@Naval"), targetHandleKey("naval"));
  });

  it("accepts real X handles and rejects malformed ones", () => {
    assert.equal(validateTargetHandle("@naval").handle, "@naval");
    assert.equal(validateTargetHandle("a_1").handle, "@a_1");
    // 15 chars is the X maximum; 16 is not.
    assert.equal(validateTargetHandle("a".repeat(15)).ok, true);
    assert.equal(validateTargetHandle("a".repeat(16)).ok, false);
    assert.equal(validateTargetHandle("").ok, false);
    assert.equal(validateTargetHandle("@has spaces").ok, false);
    assert.equal(validateTargetHandle("@dots.not.allowed").ok, false);
  });
});

describe("curated target lists", () => {
  const targets = [
    target({ handle: "@b", addedAt: "2026-07-02T00:00:00.000Z" }),
    target({ handle: "@a", addedAt: "2026-07-01T00:00:00.000Z" }),
    target({ handle: "@paused", addedAt: "2026-07-03T00:00:00.000Z", active: false }),
    target({ handle: "@other", accountId: "persona-2" }),
  ];

  it("returns one persona's targets oldest first, never another persona's", () => {
    assert.deepEqual(
      curatedTargetsFor(targets, "persona-1").map((t) => t.handle),
      ["@a", "@b", "@paused"],
    );
    assert.deepEqual(curatedTargetsFor(targets, "persona-2").map((t) => t.handle), ["@other"]);
  });

  it("excludes paused targets from the engageable list", () => {
    assert.deepEqual(
      activeCuratedTargetsFor(targets, "persona-1").map((t) => t.handle),
      ["@a", "@b"],
    );
  });
});

describe("adding a curated target", () => {
  it("accepts a valid new handle and returns its canonical form", () => {
    const check = checkCuratedTargetAddition([], "persona-1", "naval");
    assert.equal(check.ok, true);
    assert.equal(check.handle, "@naval");
  });

  it("rejects a duplicate regardless of case or @ prefix", () => {
    const existing = [target({ handle: "@Naval" })];
    const check = checkCuratedTargetAddition(existing, "persona-1", "naval");
    assert.equal(check.ok, false);
    assert.match(check.error!, /already on this list/);
  });

  it("allows the same handle on a different persona's list", () => {
    const existing = [target({ handle: "@naval", accountId: "persona-2" })];
    assert.equal(checkCuratedTargetAddition(existing, "persona-1", "naval").ok, true);
  });

  it("enforces the per-persona cap", () => {
    const full = Array.from({ length: MAX_CURATED_TARGETS_PER_ACCOUNT }, (_, i) =>
      target({ handle: `@t${i}` }),
    );
    const check = checkCuratedTargetAddition(full, "persona-1", "@onemore");
    assert.equal(check.ok, false);
    assert.match(check.error!, /max 7/);
  });

  it("counts only active targets against the cap, so a substitution fits", () => {
    // A full list with one paused target has room for its replacement.
    const withPaused = [
      ...Array.from({ length: MAX_CURATED_TARGETS_PER_ACCOUNT - 1 }, (_, i) =>
        target({ handle: `@t${i}` }),
      ),
      target({ handle: "@retired", active: false }),
    ];
    assert.equal(checkCuratedTargetAddition(withPaused, "persona-1", "@replacement").ok, true);
  });

  it("rejects a malformed handle before any list checks", () => {
    assert.equal(checkCuratedTargetAddition([], "persona-1", "@way too long a handle").ok, false);
  });
});
