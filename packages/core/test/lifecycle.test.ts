import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyKeepWarm,
  applyWarmupProgress,
  canPost,
  isWarmOnlyPlatform,
  markPosting,
  postCycleScript,
  supportsAutoPost,
  TRUST_PER_WARMUP,
  type SocialAccount,
} from "../src/index.js";

function account(partial: Partial<SocialAccount> & Pick<SocialAccount, "stage" | "platform">): SocialAccount {
  return {
    id: partial.id ?? "a1",
    deviceId: "d1",
    platform: partial.platform,
    handle: "@t",
    stage: partial.stage,
    trustScore: partial.trustScore ?? 0,
    searchTerms: partial.searchTerms ?? ["saas"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("account lifecycle", () => {
  it("blocks fresh accounts from posting", () => {
    const fresh = account({ stage: "fresh", platform: "tiktok" });
    assert.equal(canPost(fresh), false);
    assert.throws(() => markPosting(fresh), /cannot enter posting/);
  });

  it("allows matured tiktok/instagram to post", () => {
    assert.equal(canPost(account({ stage: "matured", platform: "tiktok" })), true);
    assert.equal(canPost(account({ stage: "kept_warm", platform: "instagram" })), true);
    assert.equal(canPost(account({ stage: "posting", platform: "tiktok" })), true);
  });

  it("never allows X/LinkedIn auto-post", () => {
    assert.equal(canPost(account({ stage: "matured", platform: "x" })), false);
    assert.equal(canPost(account({ stage: "matured", platform: "linkedin" })), false);
    assert.equal(isWarmOnlyPlatform("x"), true);
    assert.equal(supportsAutoPost("instagram"), true);
    assert.equal(supportsAutoPost("linkedin"), false);
  });

  it("advances trust and stage through warmups until matured", () => {
    let a = account({ stage: "fresh", platform: "tiktok", trustScore: 0 });
    a = applyWarmupProgress(a, "t1");
    assert.equal(a.stage, "warmed_up");
    assert.equal(a.trustScore, TRUST_PER_WARMUP);
    a = applyWarmupProgress(a, "t2");
    a = applyWarmupProgress(a, "t3");
    a = applyWarmupProgress(a, "t4");
    assert.equal(a.trustScore, 100);
    assert.equal(a.stage, "matured");
    assert.equal(canPost(a), true);
  });

  it("keep-warm moves matured to kept_warm", () => {
    const a = applyKeepWarm(account({ stage: "matured", platform: "tiktok", trustScore: 100 }));
    assert.equal(a.stage, "kept_warm");
  });

  it("post cycle script wraps pre and post warmup around publish", () => {
    const script = postCycleScript(["founders"]);
    assert.ok(script.some((s) => s.startsWith("pre_warmup:")));
    assert.ok(script.includes("post:publish"));
    assert.ok(script.some((s) => s.startsWith("post_warmup:")));
    const pre = script.filter((s) => s.startsWith("pre_warmup:"));
    const post = script.filter((s) => s.startsWith("post_warmup:"));
    assert.ok(pre.length >= 4);
    assert.ok(post.length >= 4);
    assert.ok(script.indexOf("post:publish") > script.indexOf(pre[0]!));
    assert.ok(script.indexOf(post[0]!) > script.indexOf("post:publish"));
  });
});
