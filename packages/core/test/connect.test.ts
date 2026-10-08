import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  connectEligibility, connectFirstName, connectFollowConfirmed, connectReply, connectTargetKey,
  parseConnectPostPage, parseConnectResults,
  CONNECT_REPLY_VARIANTS, type ScreenLine,
} from "../src/index.js";

const line = (t: string, y: number, x = 0.2): ScreenLine => ({ t, x, y, w: 0.6, h: 0.02 });

describe("#connect: reading a results page", () => {
  it("finds post headers, ignores mentions in bodies, and sorts newest first", () => {
    const page = [
      line("Vlad C @vlatdd · 2h", 0.20),
      line("Building apps. Say hi to @lumaaffirmation #connect", 0.24),
      line("Maya 🚀 @maya_builds • 12m", 0.45),
      line("#connect with builders", 0.49),
      line("Old Timer @oldtimer · 5h", 0.70),
    ];
    const found = parseConnectResults([page]);
    assert.deepEqual(found.map((c) => [c.handle, c.ageMinutes, c.firstName]),
      [["@maya_builds", 12, "Maya"], ["@vlatdd", 120, "Vlad"], ["@oldtimer", 300, "Old"]]);
  });
  it("takes the name from the line above when X wraps the header, and dedupes across pages", () => {
    const pageOne = [line("Dr. Ana María López", 0.30), line("@anamaria · 45s", 0.325)];
    const pageTwo = [line("Dr. Ana María López @anamaria · 1h", 0.10)];
    const found = parseConnectResults([pageOne, pageTwo]);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.ageMinutes, 0, "keeps the fresher post");
    assert.equal(found[0]!.firstName, "Dr");
  });
});

describe("#connect: the real results layout (2026-10-08 scan)", () => {
  const at = (t: string, x: number, y: number): ScreenLine => ({ t, x, y, w: 0.3, h: 0.019 });
  it("pairs the name on the same row with its handle, and handles cut-off handles", () => {
    const found = parseConnectResults([[
      at("Vladimir Panev", 0.157, 0.180), at("@VPanev27435 •7m", 0.488, 0.181),
      at("Gustav Joubert", 0.155, 0.744), at("@Gustav_Jou.. 10m", 0.485, 0.745),
    ], [at("Vladimir Panev", 0.157, 0.300), at("@VPanev27.. 44m", 0.488, 0.301)]]);
    assert.deepEqual(found.map((c) => [c.handle, c.firstName, c.ageMinutes, !!c.handleTruncated]),
      [["@VPanev27435", "Vladimir", 7, false], ["@Gustav_Jou", "Gustav", 10, true]]);
  });
});

describe("#connect: names", () => {
  it("uses the first readable word, else the handle, else nothing", () => {
    assert.equal(connectFirstName("🔥 Jon | building in public", "@jonb"), "Jon");
    assert.equal(connectFirstName("🚀🚀", "@rocketlabs99"), "rocketlabs");
    assert.equal(connectFirstName("", "@x9"), "");
  });
});

describe("#connect: who qualifies", () => {
  const base = { handle: "@Maya_Builds", displayName: "Maya", ageMinutes: 12, firstName: "Maya" };
  const opts = { ownedHandles: ["@manxlab"], alreadyConnected: [connectTargetKey("@someone")] };
  it("accepts a fresh stranger and rejects old, own and repeat accounts", () => {
    assert.equal(connectEligibility(base, opts).reason, "eligible");
    assert.equal(connectEligibility({ ...base, ageMinutes: 180 }, opts).reason, "too_old");
    assert.equal(connectEligibility({ ...base, handle: "@ManxLab" }, opts).reason, "own_account");
    assert.equal(connectEligibility(base, { ...opts, alreadyConnected: [connectTargetKey("@maya_builds")] }).reason, "already_connected");
  });
});

describe("#connect: the reply", () => {
  it("uses the operator's wordings verbatim and fills in the name", () => {
    assert.equal(connectReply("Maya", 0.3).text, "Maya followed you, let’s connect 🤝");
    assert.equal(connectReply("Maya", 0.99).text, "followed you Maya, let’s connect 🤝");
  });
  it("never repeats the last wording, and never leaves a blank name", () => {
    for (let last = 0; last < CONNECT_REPLY_VARIANTS.length; last++) {
      for (const pick of [0, 0.25, 0.5, 0.75, 0.999]) {
        assert.notEqual(connectReply("Maya", pick, last).variant, last);
        const nameless = connectReply("", pick, last).text;
        assert.ok(!nameless.includes("<name>") && !nameless.includes("  "), nameless);
      }
    }
  });
});

describe("#connect: the hidden Follow button", () => {
  // Real measurements from the SE on 2026-10-08, before and after following.
  const page = (w: number, y: number): ScreenLine[] => [
    { t: "Post", x: 0.45, y: 0.05, w: 0.1, h: 0.02 }, { t: "@KanishkGiri2", x: 0.16, y: 0.15, w: 0.3, h: 0.02 },
    { t: "X.com", x: 0.788, y, w, h: 0.028 }, { t: "2:12 PM • 10/8/26 • 62 Views", x: 0.02, y: 0.52, w: 0.5, h: 0.02 },
  ];
  it("tells Follow from Message by the placeholder's width, without tapping", () => {
    for (const [w, y] of [[0.160, 0.121], [0.161, 0.120], [0.163, 0.121]] as const) {
      assert.ok(parseConnectPostPage(page(w, y)).followButton, `Follow at ${w}`);
    }
    for (const [w, y] of [[0.168, 0.128], [0.170, 0.128], [0.173, 0.124]] as const) {
      const read = parseConnectPostPage(page(w, y));
      assert.equal(read.followButton, undefined, `Message at ${w}`);
      assert.equal(read.alreadyFollowing, true);
    }
  });
  it("confirms a follow only once the button has become Message-sized", () => {
    assert.equal(connectFollowConfirmed(page(0.170, 0.128)), true);
    assert.equal(connectFollowConfirmed(page(0.161, 0.121)), false, "still Follow: X did not take it");
    assert.equal(connectFollowConfirmed([...page(0.170, 0.128), { t: "You are unable to follow more people at this time.", x: 0.1, y: 0.5, w: 0.8, h: 0.02 }]), false);
  });
});
