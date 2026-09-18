import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessControllerHeartbeat,
  shouldRaiseControllerAlarm,
  CONTROLLER_STALE_AFTER_MS,
  CONTROLLER_ALARM_REPEAT_MS,
  stalePause,
} from "../src/index.js";

const now = "2026-09-18T12:00:00.000Z";
const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString();

describe("controller heartbeat", () => {
  it("calls a fresh heartbeat alive and a stale one dead", () => {
    assert.equal(assessControllerHeartbeat(ago(30_000), now).alive, true);
    assert.equal(assessControllerHeartbeat(ago(CONTROLLER_STALE_AFTER_MS - 1_000), now).alive, true);
    const dead = assessControllerHeartbeat(ago(8 * 60_000), now);
    assert.equal(dead.alive, false);
    assert.match(dead.detail, /no controller heartbeat for 8 minutes/);
  });

  it("treats a missing or unreadable heartbeat as dead, and a future one as a clock change", () => {
    assert.equal(assessControllerHeartbeat(undefined, now).alive, false);
    assert.equal(assessControllerHeartbeat("not-a-date", now).alive, false);
    assert.equal(assessControllerHeartbeat(ago(-60_000), now).alive, true, "clock moved, not a dead controller");
  });

  it("replays 2026-09-18: dead since 04:21, found at 12:00", () => {
    const health = assessControllerHeartbeat("2026-09-18T04:21:07.000Z", "2026-09-18T12:00:00.000Z");
    assert.equal(health.alive, false);
    assert.match(health.detail, /no controller heartbeat for 459 minutes/);
  });
});

describe("controller alarm", () => {
  it("raises on the way down, stays quiet while healthy, and repeats only occasionally", () => {
    assert.equal(shouldRaiseControllerAlarm(undefined, false, now), true, "first sighting");
    assert.equal(shouldRaiseControllerAlarm({ alive: true }, false, now), true, "healthy -> down");
    assert.equal(shouldRaiseControllerAlarm({ alive: true }, true, now), false, "still healthy");
    assert.equal(shouldRaiseControllerAlarm({ alive: false, notifiedAt: ago(5 * 60_000) }, false, now), false,
      "already told you 5 minutes ago");
    assert.equal(shouldRaiseControllerAlarm({ alive: false, notifiedAt: ago(CONTROLLER_ALARM_REPEAT_MS + 1_000) }, false, now), true,
      "still down half an hour later");
    assert.equal(shouldRaiseControllerAlarm({ alive: false, notifiedAt: ago(60_000) }, true, now), false,
      "recovered — no alarm");
  });
});

describe("a farm left paused", () => {
  it("is quiet about a deliberate short pause and loud about a forgotten one", () => {
    assert.equal(stalePause({ mode: "running" }, now).stale, false);
    assert.equal(stalePause(undefined, now).stale, false);
    assert.equal(stalePause({ mode: "active", reason: "Fixing the runner", enteredAt: ago(20 * 60_000) }, now).stale,
      false, "20 minutes in is someone working");
    const forgotten = stalePause({ mode: "active", reason: "Detach from desktop", enteredAt: ago(5 * 60 * 60_000) }, now);
    assert.equal(forgotten.stale, true);
    assert.match(forgotten.detail, /paused for 5h \(Detach from desktop\)/);
  });

  it("replays the four idle weeks: paused 2026-08-19, still paused", () => {
    const pause = stalePause(
      { mode: "active", reason: "Detach from desktop", enteredAt: "2026-08-19T19:22:56.744Z" },
      "2026-09-17T22:00:00.000Z",
    );
    assert.equal(pause.stale, true);
    assert.match(pause.detail, /paused for \d+h/);
  });
});
