import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectFollowingKey, connectTargetKey, type ScreenLine } from "@heiss/core";
import { runConnectSession } from "../src/connect-routine.js";

const L = (t: string, x: number, y: number): ScreenLine => ({ t, x, y, w: 0.4, h: 0.02 });
const results: ScreenLine[] = [
  L("Top", 0.03, 0.12), L("Latest", 0.24, 0.12),
  L("Maya Lee", 0.15, 0.18), L("@maya_builds • 7m", 0.48, 0.181), L("Shipping my first iOS app this week, say hi", 0.15, 0.21),
  L("Old Timer", 0.15, 0.40), L("@oldtimer • 5h", 0.48, 0.401), L("Been building for years, happy to meet you", 0.15, 0.43),
  L("Sam Roe", 0.15, 0.60), L("@samroe • 20m", 0.48, 0.601), L("Looking to meet other founders building here", 0.15, 0.63),
];
// X hides the button from captures; the placeholder's size and position tell
// Follow (0.161 wide, top 0.121) from Message (0.170, 0.128). Measured on the SE.
const postPage = (handle: string, following = false, withIcons = true): ScreenLine[] => [
  L("Post", 0.45, 0.05), L("Someone", 0.2, 0.12), L(handle, 0.2, 0.15),
  { t: "X.com", x: 0.788, y: following ? 0.128 : 0.121, w: following ? 0.170 : 0.161, h: 0.028 },
  ...(withIcons ? [L("2:12 PM · 10/8/26 · 18 Views", 0.04, 0.60)] : []),
];

type Call = { action: string; input: Record<string, unknown> };

/** A fake phone. It tracks which post is open and whether it was followed. */
function fakePhone(opts: {
  pages?: Record<string, ScreenLine[]>;
  /** What a live reply step reports; default "posted". */
  reply?: string;
  /** What the pre-follow check of the reply screen reports; default "ok". */
  probe?: string;
  /** false: the follow tap leaves the button Follow-sized (X refused). */
  followTakes?: boolean;
} = {}) {
  const calls: Call[] = [];
  let open = "";
  const followed = new Set<string>();
  const here = () => opts.pages?.[open] ?? postPage(open, followed.has(open));
  const step = async (action: string, input: Record<string, unknown>) => {
    calls.push({ action, input });
    if (action === "x:connect_scan") return { pages: [results] };
    if (action === "x:connect_open") {
      const y = input.connectTapY as number;
      open = y < 0.3 ? "@maya_builds" : y < 0.5 ? "@oldtimer" : "@samroe";
      return { lines: here() };
    }
    if (action === "x:connect_page") return { lines: open ? postPage(open, followed.has(open)) : results };
    const live = input.connectRehearse === false;
    const out: Record<string, unknown> = {};
    if (input.connectProbe) out.probe = opts.probe ?? "ok";
    if (input.connectReply) {
      out.pasted = true;
      out.reply = live ? (opts.reply ?? "posted") : "rehearsed";
      if (live) out.like = "tapped";
    }
    if (input.connectFollowX !== undefined && live) {
      if (opts.followTakes !== false) followed.add(open);
      out.follow = "tapped";
      out.afterFollow = postPage(open, followed.has(open));
    }
    // Back to the results unless told to stay on the post.
    if (input.connectBack === false) out.lines = here();
    else { out.lines = results; open = ""; }
    return out;
  };
  return { step, calls, followed };
}

const base = { ownedHandles: ["@manxlab"], alreadyConnected: [] as string[], random: () => 0.1 };
const commits = (calls: Call[]) => calls.filter((call) => call.action === "x:connect_commit");

describe("#connect session", () => {
  it("rehearsal never asks the phone to like, post or follow", async () => {
    const phone = fakePhone();
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: false, maxScrolls: 1 });
    assert.deepEqual(run.outcomes.filter((o) => o.result === "rehearsed").map((o) => o.handle), ["@maya_builds", "@samroe"]);
    assert.ok(commits(phone.calls).every((call) => call.input.connectRehearse === true));
    assert.equal(run.outcomes.find((o) => o.handle === "@oldtimer")?.reason, "too_old");
    assert.equal(phone.followed.size, 0);
  });

  const kind = (call: Call) => call.action === "x:connect_page" ? "scroll"
    : call.input.connectProbe ? "check" : call.input.connectReply ? "reply"
    : call.input.connectFollowX !== undefined ? "follow" : call.action.replace("x:connect_", "");

  it("live: checks the reply screen, then follows, then likes and replies", async () => {
    const phone = fakePhone();
    const remembered: string[] = [];
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true, onFollowed: (handle) => remembered.push(handle) });
    assert.deepEqual(run.outcomes.filter((o) => o.result === "connected").map((o) => o.handle), ["@maya_builds"]);
    assert.deepEqual(remembered, ["@maya_builds"]);
    assert.deepEqual(phone.calls.slice(1).map(kind), ["open", "check", "follow", "reply"]);
    const reply = commits(phone.calls).find((call) => call.input.connectReply)!;
    assert.equal(reply.input.connectLikeY, reply.input.connectReplyY, "the like is on the reply's icon row");
    assert.equal(commits(phone.calls).find((call) => call.input.connectProbe)!.input.connectRehearse, true, "the check types and posts nothing");
    assert.equal(run.stoppedBecause, "reached_max");
  });

  it("if the reply screen will not open for the right person, nobody is followed", async () => {
    const phone = fakePhone({ probe: "composer_not_open" });
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: true, maxScrolls: 0 });
    assert.equal(phone.followed.size, 0, "no follow without a working reply");
    assert.ok(commits(phone.calls).every((call) => call.input.connectFollowX === undefined && !call.input.connectReply));
    assert.ok(run.outcomes.filter((o) => o.reason === "composer_not_open").length >= 2, "it moves on to the next person");
  });

  it("stops if a reply fails after the follow, and says so", async () => {
    const phone = fakePhone({ reply: "post_button_not_found" });
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: true });
    assert.equal(run.stoppedBecause, "reply_failed");
    assert.equal(run.outcomes.find((o) => o.result === "followed_reply_failed")?.handle, "@maya_builds");
    assert.equal(phone.followed.size, 1, "it does not go on to follow anyone else");
  });

  it("never posts when the reply box holds anything but the intended reply", async () => {
    const phone = fakePhone({ reply: "reply_text_mismatch" });
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: true });
    assert.equal(run.stoppedBecause, "reply_text_mismatch");
    assert.equal(commits(phone.calls).filter((call) => call.input.connectReply).length, 1, "it stops after the first");
  });

  it("skips someone already followed without tapping anything, and people already connected", async () => {
    const phone = fakePhone({ pages: { "@maya_builds": postPage("@maya_builds", true) } });
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "already_following");
    assert.deepEqual(run.outcomes.filter((o) => o.result === "connected").map((o) => o.handle), ["@samroe"]);

    const again = await runConnectSession(fakePhone().step, {
      ...base, max: 5, live: true, maxScrolls: 0,
      alreadyConnected: [connectTargetKey("@maya_builds"), connectTargetKey("@samroe")],
    });
    assert.ok(again.outcomes.every((o) => o.result === "skipped"), "nobody is connected with twice");
  });

  it("remembers who this account already follows, and next time skips them without opening the post", async () => {
    const first = fakePhone({ pages: { "@maya_builds": postPage("@maya_builds", true) } });
    const learned: string[] = [];
    await runConnectSession(first.step, { ...base, max: 1, live: true, onAlreadyFollowing: (handle) => learned.push(handle) });
    assert.deepEqual(learned, ["@maya_builds"]);

    const second = fakePhone({ pages: { "@maya_builds": postPage("@maya_builds", true) } });
    const run = await runConnectSession(second.step, { ...base, max: 1, live: true, knownFollowing: learned.map(connectFollowingKey) });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "already_following");
    assert.equal(second.calls.filter((call) => call.action === "x:connect_open").length, 1, "only @samroe's post was opened");
  });

  it("stops when a follow does not take, before liking or replying", async () => {
    const phone = fakePhone({ followTakes: false });
    const remembered: string[] = [];
    const run = await runConnectSession(phone.step, { ...base, max: 5, live: true, onFollowed: (handle) => remembered.push(handle) });
    assert.equal(run.stoppedBecause, "follow_not_confirmed");
    assert.deepEqual(remembered, []);
    assert.ok(commits(phone.calls).every((call) => !call.input.connectReply), "no reply to someone it could not follow");
  });

  it("on a long post: scrolls to check the reply screen, follows, scrolls again, replies", async () => {
    const phone = fakePhone({ pages: { "@maya_builds": postPage("@maya_builds", false, false) } });
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.result, "connected");
    assert.deepEqual(phone.calls.slice(1).map(kind), ["open", "scroll", "check", "follow", "scroll", "reply"]);
  });

  it("taps a long post twice (the first tap only expands it)", async () => {
    const phone = fakePhone();
    let opens = 0;
    const step = async (action: string, input: Record<string, unknown>) => {
      if (action === "x:connect_open" && opens++ === 0) { phone.calls.push({ action, input }); return { lines: results }; }
      return phone.step(action, input);
    };
    const run = await runConnectSession(step, { ...base, max: 1, live: false });
    assert.equal(run.outcomes.find((o) => o.result === "rehearsed")?.handle, "@maya_builds");
    assert.equal(phone.calls.filter((call) => call.action === "x:connect_open").length, 2);
  });

  it("a tap that opens a picture is backed out of, and the session carries on", async () => {
    const viewer = [L("Notifications", 0.1, 0.07), L("@zrout • 17m", 0.2, 0.4)];
    const phone = fakePhone({ pages: { "@maya_builds": viewer } });
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "opened_something_else");
    assert.equal(run.outcomes.find((o) => o.result === "connected")?.handle, "@samroe");
  });

  it("does not approach the same person twice when OCR reads their handle differently", async () => {
    const twice = [...results, L("Maya Lee", 0.15, 0.70), L("@maya_bui1ds • 9m", 0.48, 0.701), L("Another post from the same person today", 0.15, 0.73)];
    const phone = fakePhone();
    const step = async (action: string, input: Record<string, unknown>) => {
      if (action === "x:connect_scan") return { pages: [twice] };
      const out = await phone.step(action, input);
      return action === "x:connect_commit" && input.connectBack !== false ? { ...out, lines: twice } : out;
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
    const phone = fakePhone({ pages: { "@maya_builds": postPage("@someone_else") } });
    const run = await runConnectSession(phone.step, { ...base, max: 1, live: true });
    assert.equal(run.outcomes.find((o) => o.handle === "@maya_builds")?.reason, "opened_a_different_page");
  });
});
