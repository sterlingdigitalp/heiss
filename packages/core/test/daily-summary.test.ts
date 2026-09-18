import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDailySummary,
  emptyState,
  failureSignature,
  lastScheduledMinute,
  repeatedFailureCount,
  REPEATED_FAILURE_LIMIT,
  summaryDue,
  summaryIsBad,
} from "../src/index.js";

const DAY = "2026-09-18";
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`; // 09:00 CDT = 14:00Z

function farm() {
  const state = emptyState();
  state.settings.timeZone = "America/Chicago";
  state.devices.push({ id: "d1", name: "iPhone", udid: "U1", online: true, createdAt: at("00:00") });
  for (const [id, handle, warm, engage] of [
    ["a1", "@one", "09:00", "09:08"], ["a2", "@two", "09:17", "09:25"],
  ] as const) {
    state.accounts.push({
      id, deviceId: "d1", platform: "x", handle, stage: "matured", trustScore: 100,
      searchTerms: [], createdAt: at("00:00"), curatedEngagementAt: engage,
    });
    state.warmupSchedules.push({ id: `w-${id}`, accountId: id, timeOfDay: warm, jitterMinutes: 2, enabled: true });
  }
  return state;
}

describe("daily summary", () => {
  it("reports only after the last window plus grace, and once per day", () => {
    const state = farm();
    assert.equal(lastScheduledMinute(state), 9 * 60 + 25, "latest of warmups and engagements");
    assert.equal(summaryDue(state, at("14:30")), false, "09:30 local — windows still open");
    assert.equal(summaryDue(state, at("15:15")), true, "10:15 local — past the last window + grace");
    state.settings.notificationKeys.dailySummary = DAY;
    assert.equal(summaryDue(state, at("15:15")), false, "already reported today");
    state.settings.notificationKeys.dailySummary = "2026-09-17";
    assert.equal(summaryDue(state, at("15:15")), true, "a new day reports again");
  });

  it("counts what actually happened and calls a good day good", () => {
    const state = farm();
    for (const account of state.accounts) account.lastWarmupAt = at("14:10");
    state.curatedTargets.push(
      { id: "t1", accountId: "a1", handle: "@x", active: true, addedAt: at("00:00"), engagedCount: 1,
        lastAttemptedAt: at("15:00"), lastEngagedAt: at("15:00") },
      { id: "t2", accountId: "a2", handle: "@y", active: true, addedAt: at("00:00"), engagedCount: 1,
        lastAttemptedAt: at("15:05"), lastEngagedAt: at("15:05") },
    );
    const summary = buildDailySummary(state, at("15:30"));
    assert.equal(summary.headline, "warmups 2/2 · engagements 2/2");
    assert.equal(summaryIsBad(summary), false);
  });

  it("replays 2026-09-18: warmups fine, every engagement failed, one persona stopped", () => {
    const state = farm();
    for (const account of state.accounts) account.lastWarmupAt = at("08:00");
    // Attempts recorded, nothing landed.
    state.curatedTargets.push(
      { id: "t1", accountId: "a1", handle: "@x", active: true, addedAt: at("00:00"), engagedCount: 0, lastAttemptedAt: at("15:00") },
    );
    state.settings.curatedFailures = { a2: { streak: 3, lastError: "Keyboard key _ was not available", lastAt: at("15:00"), blockedDay: DAY } };
    state.sessions.push({
      id: "s1", ownerPid: 1, accountId: "a1", deviceId: "d1", kind: "keep_warm", status: "checkpointed",
      startedAt: at("14:00"), updatedAt: at("14:20"), requiresAttention: true,
      checkpoint: { stepIndex: 3, stepsCompleted: [], contentAssigned: false, posted: false }, activityLog: [],
    });
    const summary = buildDailySummary(state, at("15:30"));
    assert.equal(summary.engagementsLanded, 0);
    assert.equal(summary.engagementsAttempted, 1);
    assert.deepEqual(summary.blockedPersonas, ["@two"]);
    assert.deepEqual(summary.needsAttention, ["@one"]);
    assert.match(summary.headline, /stopped: @two/);
    assert.match(summary.headline, /needs you: @one/);
    assert.equal(summaryIsBad(summary), true);
  });
});

describe("repeated failure escalation", () => {
  it("treats identical wording as the same failure, ignoring ids, paths and numbers", () => {
    const a = "Runner did not execute x:target_scan: Keyboard key _ was not available (screenshot: failure-873B83EF-1D44.png). Saved to /Users/x/y.png.";
    const b = "Runner did not execute x:target_scan: Keyboard key _ was not available (screenshot: failure-6FA6DD45-B532.png). Saved to /Users/x/z.png.";
    assert.equal(failureSignature(a), failureSignature(b));
    assert.notEqual(failureSignature(a), failureSignature("Runner did not execute x:target_engage: post not found"));
  });

  it("escalates on the third identical failure, and resets when the failure changes", () => {
    const message = "Keyboard key _ was not available";
    let signature: string | undefined;
    let count: number | undefined;
    const flags: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const result = repeatedFailureCount(signature, count, message);
      ({ signature, count } = result);
      flags.push(result.deterministic);
    }
    assert.deepEqual(flags, [false, false, true, true]);
    assert.equal(count, 4);

    const changed = repeatedFailureCount(signature, count, "device is busy");
    assert.equal(changed.count, 1, "a different failure starts over");
    assert.equal(changed.deterministic, false);
    assert.equal(REPEATED_FAILURE_LIMIT, 3);
  });
});

describe("summary when the farm is paused", () => {
  it("leads with the pause and calls the day bad", () => {
    const state = farm();
    state.settings.maintenance = { mode: "active", reason: "Detach from desktop", enteredAt: at("14:00") };
    const summary = buildDailySummary(state, at("15:30"));
    assert.equal(summary.paused, true);
    assert.match(summary.headline, /^PAUSED \(Detach from desktop\) — nothing scheduled ran/);
    assert.equal(summaryIsBad(summary), true);
  });
});
