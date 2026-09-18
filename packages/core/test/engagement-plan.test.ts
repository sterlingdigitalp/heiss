import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEngagementCount,
  postEngagementScore,
  choosePostForEngagement,
  planDailyEngagement,
  pickDueEngagementPersona,
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

describe("engagement holds until the persona's own hour", () => {
  // Without a scheduled time the engagement fires on the first idle tick after
  // the calendar day rolls over — all five personas inside half an hour of
  // midnight, every night, which is a pattern no human has.
  const tz = "America/Chicago";
  const base = {
    id: "t1", accountId: "acct-1", handle: "@someone",
    active: true, addedAt: "2026-07-01T00:00:00.000Z", engagedCount: 0,
  };
  const at = (localHour: string) => `2026-08-02T${localHour}:00:00.000Z`;

  it("withholds a target before the scheduled time", () => {
    // 06:00Z = 01:00 local, well before a 10:00 local slot.
    const plan = planDailyEngagement([base], "acct-1", at("06"), tz,
      { timeOfDay: "10:00", jitterMinutes: 0 });
    assert.equal(plan.target, null);
    assert.equal(plan.reason, "before_scheduled_time");
  });

  it("releases it once the time has passed", () => {
    // 17:00Z = 12:00 local, past the 10:00 slot.
    const plan = planDailyEngagement([base], "acct-1", at("17"), tz,
      { timeOfDay: "10:00", jitterMinutes: 0 });
    assert.equal(plan.target?.handle, "@someone");
  });

  it("still runs late in the day if the slot was missed", () => {
    // Catch-up matters: a phone unplugged at 10:00 must not lose the day.
    const plan = planDailyEngagement([base], "acct-1", at("23"), tz,
      { timeOfDay: "10:00", jitterMinutes: 0 });
    assert.equal(plan.target?.handle, "@someone");
  });

  it("behaves as before when no time is configured", () => {
    const plan = planDailyEngagement([base], "acct-1", at("06"), tz);
    assert.equal(plan.target?.handle, "@someone");
  });

  it("jitter varies the effective time by day but stays bounded", () => {
    const days = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"];
    const released = days.map((day) =>
      planDailyEngagement([base], "acct-1", `${day}T14:58:00.000Z`, tz,
        { timeOfDay: "10:00", jitterMinutes: 8 }).target !== null);
    // 14:58Z = 09:58 local — inside the +/-8 minute band (09:52-10:04), so some
    // days release and some do not. Identical every day would mean no jitter.
    assert.equal(released.some(Boolean) && released.some((r) => !r), true,
      `expected mixed results across days, got ${JSON.stringify(released)}`);
  });
});

describe("picking the next persona across devices", () => {
  const target = (accountId: string) => ({
    id: `t-${accountId}`, accountId, handle: `@t${accountId}`, platform: "x" as const,
    active: true, addedAt: "2026-09-01T00:00:00.000Z", engagedCount: 0,
  });
  const account = (id: string, deviceId: string, at: string) => ({
    id, deviceId, platform: "x", curatedEngagementAt: at, curatedEngagementJitterMinutes: 0,
  });
  const base = {
    nowIso: "2026-09-18T16:00:00.000Z", // 11:00 local, every schedule below is past
    timeZone: "America/Chicago",
    actionable: () => true,
  };

  it("serves a second device when the first has nobody due", () => {
    const accounts = [account("a1", "seeDevice", "09:00"), account("b1", "newDevice", "09:30")];
    // Only b1 has a target, so device one has nothing to do this tick.
    const picked = pickDueEngagementPersona(accounts, {
      ...base, targets: [target("b1")], deviceReady: () => true,
    });
    assert.equal(picked?.id, "b1", "the idle first device must not block the second");
  });

  it("takes the most overdue persona, and never one on a device that is not ready", () => {
    const accounts = [account("late", "d2", "10:30"), account("early", "d1", "09:00")];
    const targets = [target("late"), target("early")];
    assert.equal(pickDueEngagementPersona(accounts, { ...base, targets, deviceReady: () => true })?.id, "early");
    assert.equal(
      pickDueEngagementPersona(accounts, { ...base, targets, deviceReady: (id) => id === "d2" })?.id,
      "late",
      "only the ready device's persona is eligible",
    );
    assert.equal(pickDueEngagementPersona(accounts, { ...base, targets, deviceReady: () => false }), undefined);
  });

  it("skips accounts needing attention and non-X accounts", () => {
    const accounts = [account("flagged", "d1", "09:00"), account("fine", "d1", "09:30")];
    const targets = [target("flagged"), target("fine")];
    assert.equal(
      pickDueEngagementPersona(accounts, { ...base, targets, deviceReady: () => true, actionable: (a) => a.id !== "flagged" })?.id,
      "fine",
    );
    assert.equal(
      pickDueEngagementPersona([{ ...account("ig", "d1", "09:00"), platform: "instagram" }], { ...base, targets: [target("ig")], deviceReady: () => true }),
      undefined,
    );
  });
});
