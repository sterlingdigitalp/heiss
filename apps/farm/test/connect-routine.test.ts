import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectTargetKey, type ScreenLine } from "@heiss/core";
import { runConnectSession } from "../src/connect-routine.js";

const L = (t: string, x: number, y: number): ScreenLine => ({ t, x, y, w: 0.4, h: 0.02 });
const results: ScreenLine[] = [
  L("Top", 0.03, 0.12), L("Latest", 0.24, 0.12),
  L("Maya Lee", 0.15, 0.18), L("@maya_builds • 7m", 0.48, 0.181), L("Shipping my first iOS app this week, say hi", 0.15, 0.21),
  L("Old Timer", 0.15, 0.40), L("@oldtimer • 5h", 0.48, 0.401), L("Been building for years, happy to meet you", 0.15, 0.43),
  L("Sam Roe", 0.15, 0.60), L("@samroe • 20m", 0.48, 0.601), L("Looking to meet other founders building here", 0.15, 0.63),
];
// X hides Follow from captures: "X.com" in the author row stands in for it.
const postPage = (handle: string, following = false): ScreenLine[] => [
  L("Post", 0.45, 0.05), L("Someone", 0.2, 0.12), L(handle, 0.2, 0.15),
  ...(following ? [] : [{ t: "X.com", x: 0.79, y: 0.12, w: 0.12, h: 0.02 }]),
  L("2:12 PM · 10/8/26 · 18 Views", 0.04, 0.60),
];

/** A fake phone: records what it was asked to do. */
function fakePhone(pages: Record<string, ScreenLine[]>) {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  let open = "";
  const step = async (action: string, input: Record<string, unknown>) => {
    calls.push({ action, input });
    if (action === "x:connect_scan") return { pages: [results] };
    if (action === "x:connect_page") return { lines: results };
    if (action === "x:connect_open") {
      const y = input.connectTapY as number;
      open = y < 0.3 ? "@maya_builds" : y < 0.5 ? "@oldtimer" : "@samroe";
      return { lines: pages[open] ?? postPage(open) };
    }
    const live = input.connectRehearse === false;
    return {
      lines: results, pasted: true,
      ...(live && input.connectFollowX !== undefined ? { follow: "tapped", afterFollow: postPage(open, true) } : {}),
      ...(live && input.connectReply ? { reply: "posted" } : {}),
    };
  };
  return { step, calls };
}

const base = { ownedHandles: ["@manxlab"], alreadyConnected: [] as string[], random: () => 0.1 };

describe("#connect session", () => {
  it("rehearsal never asks the phone to follow or post", async () => {
    const phone = fakePhone({});
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: false, maxScrolls: 1 });
    assert.deepEqual(run.outcomes.filter((o) => o.result === "rehearsed").map((o) => o.handle), ["@maya_builds", "@samroe"]);
    assert.ok(phone.calls.filter((c) => c.action === "x:connect_commit").every((c) => c.input.connectRehearse === true));
    assert.equal(run.outcomes.find((o) => o.handle === "@oldtimer")?.reason, "too_old");
  });

  it("live: follows and replies, stops at the cap, and skips people already followed or connected", async () => {
    const phone = fakePhone({ "@maya_builds": postPage("@maya_builds", true) });
    const followed: string[] = [];
    const run = await runConnectSession(phone.step, {
      ...base, max: 1, live: true, onFollowed: (handle) => followed.push(handle),
    });
    assert.deepEqual(followed, ["@samroe"]);
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "already_following");
    assert.equal(run.stoppedBecause, "reached_max");

    const again = await runConnectSession(fakePhone({}).step, {
      ...base, max: 5, live: true, maxScrolls: 0,
      alreadyConnected: [connectTargetKey("@maya_builds"), connectTargetKey("@samroe")],
    });
    assert.ok(again.outcomes.every((o) => o.result === "skipped"), "nobody is connected with twice");
  });

  it("stops the session the moment a follow is not confirmed", async () => {
    const phone = fakePhone({});
    const step = async (action: string, input: Record<string, unknown>) => {
      const out = await phone.step(action, input);
      return action === "x:connect_commit" ? { ...out, afterFollow: [L("You are unable to follow more people at this time.", 0.1, 0.5)] } : out;
    };
    const run = await runConnectSession(step, { ...base, max: 5, live: true });
    assert.equal(run.stoppedBecause, "follow_not_confirmed");
    assert.equal(run.outcomes.filter((o) => o.result === "connected").length, 0);
  });

  it("taps a long post twice (the first tap only expands it), and never backs out of the results", async () => {
    const phone = fakePhone({});
    let opens = 0;
    const step = async (action: string, input: Record<string, unknown>) => {
      if (action === "x:connect_open" && opens++ === 0) { phone.calls.push({ action, input }); return { lines: results }; }
      return phone.step(action, input);
    };
    const run = await runConnectSession(step, { ...base, max: 1, live: false });
    assert.equal(run.outcomes.find((o) => o.result === "rehearsed")?.handle, "@maya_builds");
    assert.equal(phone.calls.filter((c) => c.action === "x:connect_open").length, 2);
  });

  it("on a long post: follows first, scrolls to the comment bubble, then replies", async () => {
    const longPost = postPage("@maya_builds").filter((line) => !/Views/.test(line.t));
    const phone = fakePhone({ "@maya_builds": longPost });
    const step = async (action: string, input: Record<string, unknown>) => {
      if (action === "x:connect_page") { phone.calls.push({ action, input }); return { lines: postPage("@maya_builds") }; }
      return phone.step(action, input);
    };
    const followed: string[] = [];
    const run = await runConnectSession(step, { ...base, max: 1, live: true, onFollowed: (handle) => followed.push(handle) });
    assert.deepEqual(followed, ["@maya_builds"]);
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.result, "connected");
    const commits = phone.calls.filter((c) => c.action === "x:connect_commit");
    assert.equal(commits[0]!.input.connectBack, false, "stays on the post after following");
    assert.equal(commits[0]!.input.connectReply, undefined);
    assert.ok(commits[1]!.input.connectReply, "replies once the bubble is in view");
  });

  it("never posts when the reply box holds anything but the intended reply", async () => {
    const phone = fakePhone({});
    const step = async (action: string, input: Record<string, unknown>) => {
      const out = await phone.step(action, input);
      return action === "x:connect_commit" && input.connectReply ? { ...out, pasted: false, reply: "reply_text_mismatch" } : out;
    };
    const run = await runConnectSession(step, { ...base, max: 5, live: true });
    assert.equal(run.stoppedBecause, "reply_text_mismatch");
    assert.equal(run.outcomes.filter((o) => o.result === "connected").length, 0);
    assert.equal(phone.calls.filter((c) => c.action === "x:connect_commit" && c.input.connectReply).length, 1, "it stops after the first");
  });

  it("does not approach the same person twice when OCR reads their handle differently", async () => {
    const twice = [...results, L("Maya Lee", 0.15, 0.70), L("@maya_bui1ds • 9m", 0.48, 0.701), L("Another post from the same person today", 0.15, 0.73)];
    const phone = fakePhone({});
    const step = async (action: string, input: Record<string, unknown>) => {
      if (action === "x:connect_scan") return { pages: [twice] };
      const out = await phone.step(action, input);
      return action === "x:connect_commit" || action === "x:connect_page" ? { ...out, lines: twice } : out;
    };
    const run = await runConnectSession(step, { ...base, max: 5, live: false, maxScrolls: 0 });
    assert.equal(run.outcomes.filter((o) => o.result === "rehearsed" && /maya/i.test(o.handle)).length, 1);
  });

  it("stops rather than act when it is no longer on the search results", async () => {
    const homeFeed = [L("Foryou", 0.04, 0.12), L("Andrew", 0.16, 0.18), L("@AndrewCurran_ • 1h", 0.49, 0.181), L("Some post from the home feed today", 0.15, 0.21)];
    const calls: string[] = [];
    const run = await runConnectSession(async (action) => { calls.push(action); return { pages: [homeFeed], lines: homeFeed }; },
      { ...base, max: 3, live: true });
    assert.equal(run.stoppedBecause, "search_did_not_open");
    assert.deepEqual(calls, ["x:connect_scan"], "nothing was opened or tapped");
  });

  it("refuses to act when the opened page is not the person it tapped", async () => {
    const phone = fakePhone({ "@maya_builds": postPage("@someone_else") });
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "opened_a_different_page");
  });
});
