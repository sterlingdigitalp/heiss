import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approveCandidate,
  isAmbiguousCandidateHandle,
  normalizePlatformCandidateHandle,
  parseDiscoveryDetail,
  readyLikeApprovalsForTargeting,
  recordDiscoveryCandidates,
  refreshCandidateQueue,
  type EngagementActionApproval,
  type EngagementCandidate,
  type SocialAccount,
} from "../src/index.js";

const now = "2026-07-17T23:00:00.000Z";
const account: SocialAccount = {
  id: "a1", groupId: "person-1", deviceId: "d1", platform: "x", handle: "@actor",
  stage: "matured", trustScore: 100, searchTerms: ["housing affordability"], createdAt: now,
};

function detail(handles: string[], excerpt = "Housing affordability reporting by @useful") {
  return `xctest:x:search|discovery:${Buffer.from(JSON.stringify({ handles, excerpt, screenKey: "screen-1" })).toString("base64")}`;
}

describe("engagement candidate discovery", () => {
  it("parses observations and excludes actor and every owned account", () => {
    assert.deepEqual(parseDiscoveryDetail(detail(["actor", "owned", "Useful"]))?.handles, ["actor", "owned", "useful"]);
    const candidates: EngagementCandidate[] = [];
    const recorded = recordDiscoveryCandidates({ candidates, account, ownedHandles: ["@actor", "@owned"], sessionId: "s1", detail: detail(["actor", "owned", "Useful"]), now });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.targetHandle, "useful");
    assert.ok(recorded[0]!.relevanceScore > 45);
  });

  it("removes an OCR-merged X row timestamp from the public handle", () => {
    const candidates: EngagementCandidate[] = [];
    const [recorded] = recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s1", detail: detail(["whyKislay.9h"]), now });
    assert.equal(recorded?.targetHandle, "whykislay");
  });

  it("upserts repeated sightings and penalizes cross-person overlap", () => {
    const candidates: EngagementCandidate[] = [];
    recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s1", detail: detail(["useful"]), now });
    recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s2", detail: detail(["useful"]), now: "2026-07-18T00:00:00.000Z" });
    assert.equal(candidates.length, 1); assert.equal(candidates[0]?.seenCount, 2);
    const other = { ...account, id: "a2", groupId: "person-2", handle: "@other" };
    const [cross] = recordDiscoveryCandidates({ candidates, account: other, ownedHandles: [], sessionId: "s3", detail: detail(["useful"]), now });
    assert.ok(cross!.relevanceScore < candidates[0]!.relevanceScore);
  });

  it("cuts at the first illegal charset character instead of deleting it, so a merged separator+timestamp is dropped as a boundary, not stripped as noise", () => {
    const cases: Array<[string, string]> = [
      ["@realtordotcom•7h", "realtordotcom"],
      ["@pubity•18h", "pubity"],
      ["@newsandstar-1d", "newsandstar"],
      ["@CCTV_Plus•7h", "cctv_plus"],
      ["@peptidedaily_•6/9/26", "peptidedaily_"],
      ["@DeepStarts•7/8/26", "deepstarts"],
      ["@whyKislay.9h", "whykislay"],
      ["@someone·1d", "someone"],
      ["@someone 30m", "someone"],
      ["@Mrs_Glasson", "mrs_glasson"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizePlatformCandidateHandle("x", input), expected, `input: ${input}`);
    }
  });

  it("never truncates a legitimate handle that merely contains digits/letters resembling a timestamp", () => {
    const untouched = [
      "cinema4d", "blender3d", "news24h", "tech24h", "ak47s", "art2d", "studio3d",
      "trader1m", "sub4m", "level99s", "gen4s", "x99w", "peptidedaily_", "morellifit",
    ];
    for (const handle of untouched) {
      assert.equal(normalizePlatformCandidateHandle("x", handle), handle, `input: ${handle}`);
    }
  });

  it("respects per-platform legal charsets and flags genuinely ambiguous cuts without blocking normalization", () => {
    assert.equal(normalizePlatformCandidateHandle("instagram", "@user.2d"), "user.2d");
    assert.equal(isAmbiguousCandidateHandle("instagram", "@user.2d"), false);

    assert.equal(normalizePlatformCandidateHandle("tiktok", "@dailyglowup.app…"), "dailyglowup.app");
    assert.equal(isAmbiguousCandidateHandle("tiktok", "@dailyglowup.app…"), true);

    assert.equal(normalizePlatformCandidateHandle("tiktok", "@user-1d"), "user");
    assert.equal(isAmbiguousCandidateHandle("tiktok", "@user-1d"), false);

    assert.equal(normalizePlatformCandidateHandle("x", "@te"), "te");
    assert.equal(isAmbiguousCandidateHandle("x", "@te"), true);

    assert.equal(normalizePlatformCandidateHandle("x", "@abcdefghijklmnopqrst"), "abcdefghijklmno");
    assert.equal(isAmbiguousCandidateHandle("x", "@abcdefghijklmnopqrst"), true);

    assert.equal(normalizePlatformCandidateHandle("x", "@user•"), "user");
    assert.equal(isAmbiguousCandidateHandle("x", "@user•"), false);
  });

  it("records ambiguous:true on a candidate whose handle was an unresolvable observation", () => {
    const candidates: EngagementCandidate[] = [];
    const [clean] = recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s1", detail: detail(["realtordotcom•7h"]), now });
    assert.equal(clean?.targetHandle, "realtordotcom");
    const [fragment] = recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s1", detail: detail(["te"]), now });
    assert.equal(fragment?.ambiguous, true);
  });

  it("makes an exact reviewed action ready the same evening", () => {
    const candidates: EngagementCandidate[] = [];
    const [candidate] = recordDiscoveryCandidates({ candidates, account, ownedHandles: [], sessionId: "s1", detail: detail(["useful"]), now });
    const approvals: EngagementActionApproval[] = [];
    const approval = approveCandidate({ candidate: candidate!, action: "follow", approvals, allCandidates: candidates, localDay: "2026-07-17", now });
    assert.equal(approval.executeLocalDay, "2026-07-17"); assert.equal(approval.status, "ready");
    assert.equal(refreshCandidateQueue(candidates, approvals, "2026-07-17", now), 0);
    assert.equal(approval.status, "ready");
  });
});

describe("readyLikeApprovalsForTargeting", () => {
  function readyLikeApproval(overrides: Partial<EngagementActionApproval> & { targetHandle: string }): EngagementActionApproval {
    return {
      id: overrides.targetHandle, candidateId: `cand-${overrides.targetHandle}`, groupId: "person-1",
      accountId: "a1", platform: "x", action: "like",
      targetKey: `key-${overrides.targetHandle}`,
      executionMode: "assisted", status: "ready", approvedAt: now,
      executeLocalDay: "2026-07-17", expiresAt: "2026-07-20T00:00:00.000Z",
      ...overrides,
    };
  }
  function readyCandidate(handle: string, ambiguous = false): EngagementCandidate {
    return {
      id: `cand-${handle}`, groupId: "person-1", accountId: "a1", platform: "x",
      actorHandle: "@actor", targetHandle: handle, targetKey: `key-${handle}`,
      screenKey: "s", excerpt: "", searchTerms: [], relevanceScore: 50, seenCount: 1,
      firstSeenAt: now, lastSeenAt: now, sessionId: "s1", status: "approved", ambiguous,
    };
  }

  it("selects a ready like approval and skips one whose candidate is flagged ambiguous", () => {
    const candidates = [readyCandidate("clean"), readyCandidate("fuzzy", true)];
    const approvals = [readyLikeApproval({ targetHandle: "clean" }), readyLikeApproval({ targetHandle: "fuzzy" })];
    const selected = readyLikeApprovalsForTargeting({
      approvals, candidates, blockedTargetKeys: [], accountId: "a1", maxCount: 5, now,
    });
    assert.deepEqual(selected.map((approval) => approval.targetHandle), ["clean"]);
  });

  it("skips a target key present in the 30-day blocked/deduped set", () => {
    const candidates = [readyCandidate("blocked"), readyCandidate("open")];
    const approvals = [readyLikeApproval({ targetHandle: "blocked" }), readyLikeApproval({ targetHandle: "open" })];
    const selected = readyLikeApprovalsForTargeting({
      approvals, candidates, blockedTargetKeys: ["key-blocked"], accountId: "a1", maxCount: 5, now,
    });
    assert.deepEqual(selected.map((approval) => approval.targetHandle), ["open"]);
  });

  it("bounds selection to the remaining allowance and produces nothing when the budget is exhausted", () => {
    const candidates = [readyCandidate("first"), readyCandidate("second"), readyCandidate("third")];
    const approvals = [
      readyLikeApproval({ targetHandle: "first", approvedAt: "2026-07-15T00:00:00.000Z" }),
      readyLikeApproval({ targetHandle: "second", approvedAt: "2026-07-16T00:00:00.000Z" }),
      readyLikeApproval({ targetHandle: "third", approvedAt: "2026-07-17T00:00:00.000Z" }),
    ];
    const oneSlot = readyLikeApprovalsForTargeting({
      approvals, candidates, blockedTargetKeys: [], accountId: "a1", maxCount: 1, now,
    });
    assert.deepEqual(oneSlot.map((approval) => approval.targetHandle), ["first"], "oldest approval wins the single slot");
    const noBudget = readyLikeApprovalsForTargeting({
      approvals, candidates, blockedTargetKeys: [], accountId: "a1", maxCount: 0, now,
    });
    assert.deepEqual(noBudget, []);
  });

  it("excludes approvals that are not ready, are expired, or are follow actions", () => {
    const candidates = [readyCandidate("pending"), readyCandidate("stale"), readyCandidate("followonly")];
    const approvals = [
      readyLikeApproval({ targetHandle: "pending", status: "approved" }),
      readyLikeApproval({ targetHandle: "stale", expiresAt: "2026-07-01T00:00:00.000Z" }),
      readyLikeApproval({ targetHandle: "followonly", action: "follow" }),
    ];
    const selected = readyLikeApprovalsForTargeting({
      approvals, candidates, blockedTargetKeys: [], accountId: "a1", maxCount: 5, now,
    });
    assert.deepEqual(selected, []);
  });
});
