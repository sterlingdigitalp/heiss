import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeCuratedTargetsFor,
  BARREN_ATTEMPT_LIMIT,
  clearAutoPause,
  planDailyEngagement,
  recordTargetAttempt,
  type CuratedTarget,
} from "../src/index.js";

const target = (handle: string, over: Partial<CuratedTarget> = {}): CuratedTarget => ({
  id: `t-${handle}`, accountId: "a1", handle, active: true,
  addedAt: "2026-08-01T00:00:00.000Z", engagedCount: 0, followedAt: "2026-08-06T00:00:00.000Z", ...over,
});

describe("targets that never yield an engagement", () => {
  it("pauses after the limit, naming the last reason", () => {
    const wade = target("@wadefoster");
    const outcomes = [1, 2, 3].map((i) =>
      recordTargetAttempt(wade, { engaged: false, reason: "post_not_found_on_screen", nowIso: `2026-09-${18 + i}T15:00:00.000Z` }));
    assert.deepEqual(outcomes.map((o) => o.barrenAttempts), [1, 2, 3]);
    assert.deepEqual(outcomes.map((o) => o.autoPausedNow), [false, false, true]);
    assert.match(wade.autoPauseReason ?? "", /3 attempts without engaging \(last: post_not_found_on_screen\)/);
    assert.equal(BARREN_ATTEMPT_LIMIT, 3);
  });

  it("a landed engagement clears the streak — a quiet poster is not a broken one", () => {
    const alex = target("@alexalbert_", { barrenAttempts: 2 });
    recordTargetAttempt(alex, { engaged: true, reason: "complete", nowIso: "2026-09-20T15:00:00.000Z" });
    assert.equal(alex.barrenAttempts, 0);
    assert.equal(alex.autoPausedAt, undefined);
  });

  it("drops out of the rotation once paused, and the next target is picked instead", () => {
    const stuck = target("@wadefoster", { lastEngagedAt: "2026-08-06T00:00:00.000Z" });
    const fresh = target("@someoneelse", { lastEngagedAt: "2026-09-01T00:00:00.000Z" });
    const targets = [stuck, fresh];
    const now = "2026-09-20T16:00:00.000Z";

    // Least-recently-engaged first: the stuck one is picked while it is active.
    assert.equal(planDailyEngagement(targets, "a1", now, "America/Chicago").target?.handle, "@wadefoster");

    for (let i = 0; i < BARREN_ATTEMPT_LIMIT; i++) {
      recordTargetAttempt(stuck, { engaged: false, reason: "post_not_found_on_screen", nowIso: now });
    }
    assert.deepEqual(activeCuratedTargetsFor(targets, "a1").map((t) => t.handle), ["@someoneelse"]);
    assert.equal(planDailyEngagement(targets, "a1", now, "America/Chicago").target?.handle, "@someoneelse",
      "the persona's day goes to someone reachable");

    clearAutoPause(stuck);
    assert.equal(planDailyEngagement(targets, "a1", now, "America/Chicago").target?.handle, "@wadefoster",
      "resume puts it back at the front");
  });
});
