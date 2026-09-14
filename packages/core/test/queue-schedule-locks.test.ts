import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ResourceLocks,
  LockError,
  dropContent,
  claimQueueItem,
  storeLocally,
  assignToAccount,
  markPosted,
  ensureNotDoublePost,
  QueueError,
  createSlot,
  createWarmupSchedule,
  calendarDay,
  localTimeOfDay,
  effectiveWarmupTime,
  warmupScheduleIsDue,
  nextWarmupSummary,
  sessionRestMinutes,
  sessionRestRemainingMs,
  lastDeviceActivityAt,
  SESSION_REST_MIN_MINUTES,
  SESSION_REST_MAX_MINUTES,
  accountsNeedingSlotFill,
  pickAccountForQueueItem,
  assertCanAddAccount,
  assessDeviceCapacity,
  CapacityError,
  MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE,
  type SocialAccount,
} from "../src/index.js";

describe("Cloud Drop queue", () => {
  it("drops content for selected accounts and allows claim → store → assign → post", () => {
    const { content, queueItem } = dropContent({
      kind: "video",
      mediaRef: "https://cdn.example/v.mp4",
      caption: "Ship daily",
      music: "lofi",
      accountIds: ["acc-tt-mature", "acc-ig-mature"],
      createdBy: "user-1",
    });
    assert.equal(content.kind, "video");
    assert.equal(queueItem.status, "queued");
    assert.deepEqual(queueItem.accountIds, ["acc-tt-mature", "acc-ig-mature"]);
    assert.equal(queueItem.contentId, content.id);

    let item = claimQueueItem(queueItem, "runner-1");
    assert.equal(item.status, "claimed");
    assert.equal(item.claimedBy, "runner-1");
    assert.throws(() => claimQueueItem(item, "runner-2"), QueueError);

    item = storeLocally(item, "/data/v.mp4");
    assert.equal(item.status, "stored_local");
    item = assignToAccount(item, "acc-tt-mature");
    assert.equal(item.assignedAccountId, "acc-tt-mature");
    item = markPosted(item);
    assert.equal(item.status, "stored_local");
    assert.deepEqual(item.postedAccountIds, ["acc-tt-mature"]);
    item = assignToAccount(item, "acc-ig-mature");
    item = markPosted(item);
    assert.equal(item.status, "posted");
    assert.throws(() => ensureNotDoublePost(item), /double-post/);
  });

  it("fans one Cloud Drop out to every target exactly once", () => {
    const { queueItem } = dropContent({
      kind: "video", mediaRef: "clip.mp4", caption: "fan out",
      accountIds: ["a1", "a2"], createdBy: "u1",
    });
    let item = storeLocally(claimQueueItem(queueItem, "runner"), "/tmp/clip.mp4");
    item = markPosted(assignToAccount(item, "a1"));
    assert.equal(item.status, "stored_local");
    assert.deepEqual(item.postedAccountIds, ["a1"]);
    assert.throws(() => assignToAccount(item, "a1"), /already posted/);
    item = markPosted(assignToAccount(item, "a2"));
    assert.equal(item.status, "posted");
    assert.deepEqual(item.postedAccountIds, ["a1", "a2"]);
  });

  it("requires carousel slides", () => {
    assert.throws(
      () =>
        dropContent({
          kind: "carousel",
          mediaRef: "s1.jpg",
          caption: "c",
          accountIds: ["a"],
          createdBy: "u",
        }),
      QueueError,
    );
  });

  it("supports text-only X queue content", () => {
    const { content } = dropContent({
      kind: "text", mediaRef: "", caption: "A text post",
      accountIds: ["x1"], createdBy: "u",
    });
    assert.equal(content.kind, "text");
    assert.equal(content.mediaRef, "");
    assert.throws(() => dropContent({
      kind: "text", mediaRef: "", caption: " ", accountIds: ["x1"], createdBy: "u",
    }), QueueError);
  });
});

describe("schedule slot fill", () => {
  it("selects matured posting accounts with open slots", () => {
    const accounts: SocialAccount[] = [
      {
        id: "fresh",
        deviceId: "d",
        platform: "tiktok",
        handle: "@f",
        stage: "fresh",
        trustScore: 0,
        searchTerms: [],
        createdAt: "t",
      },
      {
        id: "mature",
        deviceId: "d",
        platform: "tiktok",
        handle: "@m",
        stage: "matured",
        trustScore: 100,
        searchTerms: [],
        createdAt: "t",
      },
    ];
    const slots = [createSlot("fresh", "09:00"), createSlot("mature", "09:00")];
    const needing = accountsNeedingSlotFill(accounts, slots, "09:00");
    assert.equal(needing.length, 1);
    assert.equal(needing[0]!.id, "mature");
    const picked = pickAccountForQueueItem(["fresh", "mature"], needing);
    assert.equal(picked?.id, "mature");
  });
});

describe("local warmup schedule", () => {
  it("uses the configured local day instead of UTC midnight", () => {
    assert.equal(calendarDay("2026-07-13T00:15:00.000Z", "America/Chicago"), "2026-07-12");
    assert.equal(localTimeOfDay("2026-07-13T00:15:00.000Z", "America/Chicago"), "19:15");
  });

  it("applies stable daily jitter and runs at most once per local day", () => {
    const schedule = createWarmupSchedule("a1", "20:30", 8);
    const time = effectiveWarmupTime(schedule, "2026-07-13");
    assert.equal(effectiveWarmupTime(schedule, "2026-07-13"), time);
    assert.equal(warmupScheduleIsDue(schedule, "2026-07-14T04:30:00.000Z", "America/Chicago"), true);
    assert.equal(warmupScheduleIsDue(schedule, "2026-07-14T04:30:00.000Z", "America/Chicago", "2026-07-14T01:00:00.000Z"), false);
  });

  it("labels an unrun, passed schedule as due now", () => {
    const account: SocialAccount = {
      id: "a1", deviceId: "d1", platform: "youtube", handle: "@one",
      stage: "fresh", trustScore: 0, searchTerms: [], createdAt: "t",
    };
    const schedule = createWarmupSchedule(account.id, "20:30", 0);
    assert.equal(
      nextWarmupSummary([schedule], [account], "2026-07-14T04:30:00.000Z", "America/Chicago")[0]?.day,
      "due now",
    );
  });
});

describe("session rest between scheduled sessions", () => {
  it("rests a bounded, varied, deterministic number of minutes", () => {
    const rests = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const rest = sessionRestMinutes(`2026-08-19T17:${String(i % 60).padStart(2, "0")}:0${i % 10}.000Z`);
      assert.ok(rest >= SESSION_REST_MIN_MINUTES && rest <= SESSION_REST_MAX_MINUTES);
      rests.add(rest);
    }
    assert.ok(rests.size > 1, "the rest is not a constant");
    assert.equal(sessionRestMinutes("k"), sessionRestMinutes("k"));
  });

  it("holds until the rest has elapsed, never longer than one rest", () => {
    const end = "2026-08-19T17:10:00.000Z";
    const rest = sessionRestMinutes(end) * 60_000;
    assert.equal(sessionRestRemainingMs(undefined, end), 0);
    assert.equal(sessionRestRemainingMs(end, "2026-08-19T17:11:00.000Z"), rest - 60_000);
    assert.equal(sessionRestRemainingMs(end, new Date(Date.parse(end) + rest).toISOString()), 0);
    assert.equal(sessionRestRemainingMs(end, "2026-08-20T09:00:00.000Z"), 0);
    // Clock moved backwards: still at most one rest.
    assert.equal(sessionRestRemainingMs(end, "2026-08-19T16:00:00.000Z"), rest);
  });

  it("takes the latest completion, heartbeat, or engagement attempt on that device only", () => {
    const state = {
      accounts: [{ id: "a1", deviceId: "d1" }, { id: "a2", deviceId: "d2" }],
      sessions: [
        { deviceId: "d1", completedAt: "2026-08-19T17:04:00.000Z", heartbeatAt: "2026-08-19T17:03:00.000Z" },
        { deviceId: "d1", heartbeatAt: "2026-08-19T17:20:00.000Z" },
        { deviceId: "d2", completedAt: "2026-08-19T18:00:00.000Z" },
      ],
      curatedTargets: [
        { accountId: "a1", lastAttemptedAt: "2026-08-19T17:30:31.945Z", lastEngagedAt: "not a date" },
        { accountId: "a2", lastAttemptedAt: "2026-08-19T19:00:00.000Z" },
      ],
    };
    assert.equal(lastDeviceActivityAt(state, "d1"), "2026-08-19T17:30:31.945Z");
    assert.equal(lastDeviceActivityAt(state, "d2"), "2026-08-19T19:00:00.000Z");
    assert.equal(lastDeviceActivityAt(state, "d3"), undefined);
  });
});

describe("resource locks", () => {
  it("prevents concurrent device and content double-assign", () => {
    const locks = new ResourceLocks();
    locks.acquireDevice("d1", "s1");
    assert.throws(() => locks.acquireDevice("d1", "s2"), LockError);
    locks.acquireContent("q1", "s1");
    assert.throws(() => locks.acquireContent("q1", "s2"), LockError);
    locks.releaseDevice("d1", "s1");
    locks.acquireDevice("d1", "s2");
    assert.equal(locks.holderOfDevice("d1"), "s2");
  });
});

describe("capacity", () => {
  it("enforces 8 accounts per platform per device", () => {
    const existing: SocialAccount[] = [];
    for (let i = 0; i < MAX_ACCOUNTS_PER_PLATFORM_PER_DEVICE; i++) {
      existing.push({
        id: `a${i}`,
        deviceId: "d1",
        platform: "tiktok",
        handle: `@t${i}`,
        stage: "fresh",
        trustScore: 0,
        searchTerms: [],
        createdAt: "t",
      });
    }
    assert.throws(() => assertCanAddAccount(existing, "d1", "tiktok"), CapacityError);
    assert.doesNotThrow(() => assertCanAddAccount(existing, "d1", "instagram"));
  });

  it("reports certified compact-device capacity separately from the physical maximum", () => {
    const existing: SocialAccount[] = Array.from({ length: 6 }, (_, index) => ({
      id: `x${index}`, deviceId: "compact", platform: "youtube", handle: `@y${index}`,
      stage: "fresh", trustScore: 0, searchTerms: [], createdAt: "t",
    }));
    assert.deepEqual(assessDeviceCapacity(existing, "compact", "youtube", "compact"), {
      platform: "youtube", viewportClass: "compact", configured: 6,
      certified: 5, physicalMaximum: 8, status: "uncertified",
    });
  });
});
