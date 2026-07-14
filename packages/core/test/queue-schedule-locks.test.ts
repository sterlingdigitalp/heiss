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
  accountsNeedingSlotFill,
  pickAccountForQueueItem,
  assertCanAddAccount,
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
});
