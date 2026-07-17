import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  engagementAllowance,
  engagementAutonomousEligible,
  ensureDailyEngagementApproval,
  normalizeEngagementPolicy,
  type EngagementApproval,
  type SocialAccount,
} from "../src/index.js";

function mature(): SocialAccount {
  return {
    id: "x1", deviceId: "d1", platform: "x", handle: "@one",
    stage: "matured", trustScore: 100, searchTerms: ["housing"], createdAt: "t",
    engagement: {
      mode: "review", likesEnabled: true, followsEnabled: true,
      dailyLikeCap: 2, dailyFollowCap: 1, cooldownMinutes: 720,
      successfulReviewedSessions: 0,
    },
  };
}

describe("controlled engagement", () => {
  it("defaults fail closed", () => {
    const policy = normalizeEngagementPolicy();
    assert.equal(policy.mode, "off");
    assert.equal(policy.likesEnabled, false);
    assert.equal(policy.followsEnabled, false);
  });

  it("requires a dated approval in review mode", () => {
    const account = mature();
    const approvals: EngagementApproval[] = [];
    const request = ensureDailyEngagementApproval(account, approvals, "2026-07-17", "2026-07-17T12:00:00.000Z");
    assert.equal(request?.status, "pending");
    let allowance = engagementAllowance({
      account, approvals, activity: [], localDay: "2026-07-17", now: "2026-07-17T12:00:00.000Z",
    });
    assert.deepEqual({ likes: allowance.likes, follows: allowance.follows }, { likes: 0, follows: 0 });
    request!.status = "approved";
    allowance = engagementAllowance({
      account, approvals, activity: [], localDay: "2026-07-17", now: "2026-07-17T12:00:00.000Z",
    });
    assert.deepEqual({ likes: allowance.likes, follows: allowance.follows }, { likes: 2, follows: 1 });
    assert.equal(allowance.approvalId, request!.id);
  });

  it("locks autonomous mode until three reviewed sessions", () => {
    const account = mature();
    account.engagement!.mode = "autonomous";
    assert.equal(engagementAutonomousEligible(account), false);
    account.engagement!.successfulReviewedSessions = 3;
    assert.equal(engagementAutonomousEligible(account), true);
    const allowance = engagementAllowance({
      account, approvals: [], activity: [], localDay: "2026-07-17", now: "2026-07-17T12:00:00.000Z",
    });
    assert.deepEqual({ likes: allowance.likes, follows: allowance.follows }, { likes: 2, follows: 1 });
  });

  it("subtracts executed actions from daily caps", () => {
    const account = mature();
    account.engagement!.mode = "autonomous";
    account.engagement!.successfulReviewedSessions = 3;
    const allowance = engagementAllowance({
      account, approvals: [], localDay: "2026-07-17", now: "2026-07-17T18:00:00.000Z",
      activity: [{
        id: "e1", at: "2026-07-17T13:00:00.000Z", accountId: account.id,
        kind: "engagement", message: "like executed",
        meta: { action: "like", outcome: "executed", localDay: "2026-07-17" },
      }],
    });
    assert.deepEqual({ likes: allowance.likes, follows: allowance.follows }, { likes: 1, follows: 1 });
  });
});
