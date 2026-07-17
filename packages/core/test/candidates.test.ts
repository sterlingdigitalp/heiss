import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approveCandidate,
  parseDiscoveryDetail,
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
