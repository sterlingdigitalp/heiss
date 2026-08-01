import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEngagementCount,
  postEngagementScore,
  choosePostForEngagement,
  planDailyEngagement,
  HOTTER_POST_MULTIPLE,
} from "../src/engagement-plan.js";
import type { PostSnapshot } from "../src/engagement-plan.js";
import type { CuratedTarget } from "../src/types.js";

const TZ = "America/Chicago";

function post(partial: Partial<PostSnapshot> & { key: string }): PostSnapshot {
  return { hasReadableText: true, isRepost: false, ageHours: 1, ...partial };
}

function target(partial: Partial<CuratedTarget> & { handle: string }): CuratedTarget {
  return {
    id: partial.handle,
    accountId: partial.accountId ?? "persona-1",
    handle: partial.handle,
    active: partial.active ?? true,
    addedAt: partial.addedAt ?? "2026-07-01T00:00:00.000Z",
    engagedCount: partial.engagedCount ?? 0,
    ...partial,
  };
}

describe("engagement count parsing", () => {
  it("parses plain, abbreviated, and comma-grouped counts", () => {
    assert.equal(parseEngagementCount("42"), 42);
    assert.equal(parseEngagementCount("1,234"), 1234);
    assert.equal(parseEngagementCount("1.2K"), 1200);
    assert.equal(parseEngagementCount("3M"), 3_000_000);
    assert.equal(parseEngagementCount(17), 17);
  });

  it("reads anything unparseable as zero so it cannot fake a hotter post", () => {
    assert.equal(parseEngagementCount(""), 0);
    assert.equal(parseEngagementCount(undefined), 0);
    assert.equal(parseEngagementCount("·"), 0);
    assert.equal(parseEngagementCount("-5"), 0);
  });

  it("sums likes, reposts, and replies", () => {
    assert.equal(postEngagementScore(post({ key: "a", likes: "1.2K", reposts: "10", replies: "5" })), 1215);
  });
});

describe("choosing which post to engage", () => {
  it("defaults to the most recent post", () => {
    const choice = choosePostForEngagement(post({ key: "p1", likes: 10 }), post({ key: "p2", likes: 12 }));
    assert.equal(choice.post?.key, "p1");
    assert.equal(choice.reason, "most_recent");
  });

  it("picks the preceding post when it is 3x hotter and still fresh", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 10 }),
      post({ key: "p2", likes: 30, ageHours: 5 }),
    );
    assert.equal(choice.post?.key, "p2");
    assert.equal(choice.reason, "preceding_is_hotter");
  });

  it("keeps the most recent when the gap is under the multiple", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 10 }),
      post({ key: "p2", likes: 10 * HOTTER_POST_MULTIPLE - 1, ageHours: 1 }),
    );
    assert.equal(choice.post?.key, "p1");
  });

  it("keeps the most recent when the hotter post is older than the 6h window", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 10 }),
      post({ key: "p2", likes: 5000, ageHours: 6.5 }),
    );
    assert.equal(choice.post?.key, "p1");
    assert.equal(choice.reason, "most_recent");
  });

  it("does not switch when both posts have zero engagement", () => {
    // 3 * 0 === 0 would otherwise make the older post win on no evidence.
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 0 }),
      post({ key: "p2", likes: 0, ageHours: 1 }),
    );
    assert.equal(choice.post?.key, "p1");
  });

  it("lets a fresh post with real engagement beat a brand-new post with none", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 0 }),
      post({ key: "p2", likes: 80, ageHours: 3 }),
    );
    assert.equal(choice.post?.key, "p2");
    assert.equal(choice.reason, "preceding_is_hotter");
  });

  it("never re-engages a post this persona already touched", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", likes: 10 }),
      post({ key: "p2", likes: 900, ageHours: 1 }),
      { alreadyEngagedKeys: ["p2"] },
    );
    assert.equal(choice.post?.key, "p1");
    assert.equal(choice.reason, "most_recent");
  });

  it("skips reposts and falls back to the preceding post", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", isRepost: true }),
      post({ key: "p2", likes: 3, ageHours: 30 }),
    );
    assert.equal(choice.post?.key, "p2");
    assert.equal(choice.reason, "fell_back_to_preceding");
  });

  it("skips posts with no readable text", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", hasReadableText: false }),
      post({ key: "p2", likes: 3 }),
    );
    assert.equal(choice.post?.key, "p2");
  });

  it("returns nothing when neither post is eligible", () => {
    const choice = choosePostForEngagement(
      post({ key: "p1", isRepost: true }),
      post({ key: "p2", hasReadableText: false }),
    );
    assert.equal(choice.post, null);
    assert.equal(choice.reason, "no_eligible_post");
  });

  it("handles a profile with only one post", () => {
    const choice = choosePostForEngagement(post({ key: "p1", likes: 4 }), null);
    assert.equal(choice.post?.key, "p1");
  });
});

describe("planning the daily target", () => {
  const now = "2026-07-27T18:00:00.000Z";

  it("reports when a persona has no curated targets", () => {
    assert.equal(planDailyEngagement([], "persona-1", now, TZ).reason, "no_active_targets");
  });

  it("follows unfollowed targets in curation order during week one", () => {
    const targets = [
      target({ handle: "@day1", addedAt: "2026-07-01T00:00:00.000Z", followedAt: "2026-07-25T00:00:00.000Z" }),
      target({ handle: "@day2", addedAt: "2026-07-02T00:00:00.000Z" }),
      target({ handle: "@day3", addedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const plan = planDailyEngagement(targets, "persona-1", now, TZ);
    assert.equal(plan.target?.handle, "@day2");
    assert.equal(plan.shouldFollow, true);
    assert.equal(plan.reason, "first_follow");
  });

  it("rotates to the least recently engaged once everyone is followed", () => {
    const targets = [
      target({ handle: "@a", followedAt: "2026-07-20T00:00:00.000Z", lastEngagedAt: "2026-07-25T00:00:00.000Z" }),
      target({ handle: "@b", followedAt: "2026-07-20T00:00:00.000Z", lastEngagedAt: "2026-07-21T00:00:00.000Z" }),
      target({ handle: "@c", followedAt: "2026-07-20T00:00:00.000Z", lastEngagedAt: "2026-07-24T00:00:00.000Z" }),
    ];
    const plan = planDailyEngagement(targets, "persona-1", now, TZ);
    assert.equal(plan.target?.handle, "@b");
    assert.equal(plan.shouldFollow, false);
    assert.equal(plan.reason, "rotation");
  });

  it("enforces one target per persona per local day", () => {
    const targets = [
      target({ handle: "@a", followedAt: "2026-07-20T00:00:00.000Z", lastEngagedAt: "2026-07-27T14:00:00.000Z" }),
      target({ handle: "@b" }),
    ];
    const plan = planDailyEngagement(targets, "persona-1", now, TZ);
    assert.equal(plan.target, null);
    assert.equal(plan.reason, "already_engaged_today");
  });

  it("uses the farm timezone, not UTC, to decide what 'today' is", () => {
    // 02:00 UTC on the 28th is still the 27th in Chicago, so a target engaged
    // at 18:00 UTC on the 27th must still count as today.
    const targets = [
      target({ handle: "@a", followedAt: "2026-07-20T00:00:00.000Z", lastEngagedAt: "2026-07-27T18:00:00.000Z" }),
    ];
    const plan = planDailyEngagement(targets, "persona-1", "2026-07-28T02:00:00.000Z", TZ);
    assert.equal(plan.reason, "already_engaged_today");
  });

  it("ignores paused targets entirely", () => {
    const targets = [
      target({ handle: "@paused", active: false }),
      target({ handle: "@live", addedAt: "2026-07-05T00:00:00.000Z" }),
    ];
    const plan = planDailyEngagement(targets, "persona-1", now, TZ);
    assert.equal(plan.target?.handle, "@live");
  });

  it("never plans another persona's targets", () => {
    const targets = [target({ handle: "@other", accountId: "persona-2" })];
    assert.equal(planDailyEngagement(targets, "persona-1", now, TZ).reason, "no_active_targets");
  });
});

describe("a failed attempt still spends the day", () => {
  // Recording only on success meant a target the runner could not finish was
  // retried on every idle tick forever. On 2026-08-01 @rbts4all reattempted
  // the same quote tweet in a loop at ~6 minutes per attempt, and three other
  // personas never got a turn all day.
  const tz = "America/Chicago";
  const now = "2026-08-01T20:30:00.000Z"; // 15:30 local
  const base = {
    id: "t1", accountId: "acct-1", handle: "@someone",
    active: true, addedAt: "2026-07-01T00:00:00.000Z", engagedCount: 0,
    followedAt: "2026-07-02T00:00:00.000Z",
  };

  it("does not re-offer a target already attempted today", () => {
    const plan = planDailyEngagement(
      [{ ...base, lastAttemptedAt: "2026-08-01T20:05:00.000Z" }],
      "acct-1", now, tz,
    );
    assert.equal(plan.target, null);
    assert.equal(plan.reason, "already_engaged_today");
  });

  it("offers it again the next day", () => {
    const plan = planDailyEngagement(
      [{ ...base, lastAttemptedAt: "2026-08-01T20:05:00.000Z" }],
      "acct-1", "2026-08-02T14:00:00.000Z", tz,
    );
    assert.equal(plan.target?.handle, "@someone");
  });

  it("still blocks on a successful engagement, as before", () => {
    const plan = planDailyEngagement(
      [{ ...base, lastEngagedAt: "2026-08-01T20:05:00.000Z" }],
      "acct-1", now, tz,
    );
    assert.equal(plan.target, null);
  });

  it("an untouched persona is still offered a turn", () => {
    const plan = planDailyEngagement([base], "acct-1", now, tz);
    assert.equal(plan.target?.handle, "@someone");
  });
});
