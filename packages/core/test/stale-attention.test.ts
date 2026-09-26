import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retiredAttentionSessions } from "../src/stale-attention.js";
import type { FarmSession } from "../src/types.js";

const base = {
  id: "s1", accountId: "a1", deviceId: "d1", kind: "keep_warm", status: "checkpointed",
  requiresAttention: true, escalatedOnRunnerBuild: "old-build",
  startedAt: "2026-09-22T15:00:00.000Z", updatedAt: "2026-09-22T16:36:00.000Z",
  checkpoint: { stepIndex: 3 }, activityLog: [],
} as unknown as FarmSession;
const opts = { nowIso: "2026-09-23T14:00:00.000Z", timeZone: "America/Chicago", runnerBuild: "new-build" };

describe("retiredAttentionSessions", () => {
  it("retires a parked session from an earlier day on a replaced build", () => {
    assert.deepEqual(retiredAttentionSessions([base], opts).map((s) => s.id), ["s1"]);
  });
  it("keeps it for a human when the build is unchanged, unrecorded, it parked today, or it is a post", () => {
    for (const session of [
      { ...base, escalatedOnRunnerBuild: "new-build" },
      { ...base, escalatedOnRunnerBuild: undefined },
      { ...base, updatedAt: "2026-09-23T13:00:00.000Z" },
      { ...base, requiresAttention: false },
      { ...base, status: "completed" },
      { ...base, kind: "post" },
    ] as FarmSession[]) assert.deepEqual(retiredAttentionSessions([session], opts), [], JSON.stringify(session).slice(0, 80));
  });
});
