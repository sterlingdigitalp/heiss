import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  connectEligibility, connectFirstName, connectFollowConfirmed, connectReply, connectTargetKey,
  connectStartMinute, connectSupplyByHour, connectSupplySample, parseConnectPostPage, parseConnectResults,
  planConnectBatch, type ConnectSchedule,
  CONNECT_REPLY_VARIANTS, type ScreenLine,
} from "../src/index.js";

const line = (t: string, y: number, x = 0.15): ScreenLine => ({ t, x, y, w: 0.6, h: 0.02 });

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
    for (const [w, y] of [[0.160, 0.121], [0.161, 0.120], [0.163, 0.121], [0.1653, 0.120], [0.1658, 0.120], [0.1627, 0.121], [0.1626, 0.1231]] as const) {
      assert.ok(parseConnectPostPage(page(w, y)).followButton, `Follow at ${w}`);
    }
    for (const [w, y] of [[0.168, 0.128], [0.170, 0.128], [0.173, 0.124], [0.1716, 0.125], [0.1698, 0.128], [0.1677, 0.125], [0.1665, 0.122]] as const) {
      const read = parseConnectPostPage(page(w, y));
      assert.equal(read.followButton, undefined, `Message at ${w}`);
      assert.equal(read.alreadyFollowing, true);
    }
  });
  it("confirms a follow only once the button has become Message-sized", () => {
    assert.equal(connectFollowConfirmed(page(0.170, 0.128)), true);
    assert.equal(connectFollowConfirmed(page(0.1677, 0.125)), true, "the narrowest real Message so far");
    assert.equal(connectFollowConfirmed(page(0.161, 0.121)), false, "still Follow: X did not take it");
    assert.equal(connectFollowConfirmed([...page(0.170, 0.128), { t: "You are unable to follow more people at this time.", x: 0.1, y: 0.5, w: 0.8, h: 0.02 }]), false);
  });
});

describe("#connect: finding the icon row", () => {
  const at = (t: string, x: number, y: number): ScreenLine => ({ t, x, y, w: 0.1, h: 0.02 });
  const header = [at("Post", 0.45, 0.05), at("@HemantDotDev", 0.16, 0.15)];
  it("uses the counts beside the icons when they are readable (real pages, 2026-10-08)", () => {
    // A post that fills the screen: Views at 0.75, counts at 0.80.
    const full = parseConnectPostPage([...header, at("3:02PM • 10/8/26 • 186 Views", 0.02, 0.75), at("12", 0.08, 0.80), at("07", 0.48, 0.80)]);
    assert.ok(Math.abs(full.replyButton!.y - 0.81) < 0.006, `bubble at ${full.replyButton!.y}`);
    assert.equal(full.likeButton!.y, full.replyButton!.y);
    // A short post: Views at 0.52, counts at 0.57.
    const short = parseConnectPostPage([...header, at("2:12 PM • 10/8/26 • 62 Views", 0.02, 0.52), at("8", 0.54, 0.57), at("5", 0.09, 0.57)]);
    assert.ok(Math.abs(short.replyButton!.y - 0.58) < 0.006, `bubble at ${short.replyButton!.y}`);
  });
  it("falls back to a fixed step under the Views line when no counts show", () => {
    const none = parseConnectPostPage([...header, at("2:12 PM • 10/8/26 • 18 Views", 0.02, 0.60)]);
    assert.ok(Math.abs(none.replyButton!.y - 0.66) < 0.006, `bubble at ${none.replyButton!.y}`);
  });
});

describe("#connect: text inside a post's picture", () => {
  const at = (t: string, x: number, y: number): ScreenLine => ({ t, x, y, w: 0.3, h: 0.019 });
  it("is not mistaken for a search result (real capture, 2026-10-08)", () => {
    const found = parseConnectResults([[
      at("Kritish Mohapatra", 0.155, 0.10), at("@KritishIoT • 1h", 0.45, 0.101),
      // The post's image: a screenshot of a notifications page, inset from the edge.
      at("J.Miray", 0.23, 0.23), at("and 11 others liked your post • 5m", 0.32, 0.23),
      at("Zrout", 0.24, 0.34), at("@zroutisnomore • 17m", 0.31, 0.35),
      at("matt batt", 0.24, 0.58), at("@BattMatter • 28m", 0.37, 0.58),
    ]]);
    assert.deepEqual(found.map((c) => c.handle), ["@KritishIoT"]);
  });
});

describe("#connect: supply by time of day", () => {
  const people = (ages: number[]) => ages.map((ageMinutes, i) => ({ handle: `@p${i}`, displayName: "", firstName: "", ageMinutes }));
  it("counts fresh posts from their own ages, and scales to posts per hour", () => {
    const busy = connectSupplySample(people([2, 5, 9, 14, 20, 28, 41, 55, 70]), "2026-10-09T14:10:00.000Z"); // 09:10 CDT
    assert.deepEqual([busy.fresh15, busy.fresh30, busy.fresh60, busy.reachedMinutes], [4, 6, 8, 70]);
    const quiet = connectSupplySample(people([8, 25]), "2026-10-09T21:10:00.000Z"); // 16:10 CDT, only reached 25 min
    const shallow = connectSupplySample(people([3]), "2026-10-09T21:40:00.000Z"); // reached 3 min: too little to say
    const byHour = connectSupplyByHour([busy, quiet, shallow], "America/Chicago");
    assert.deepEqual(byHour, [{ hour: 9, samples: 1, postsPerHour: 8 }, { hour: 16, samples: 1, postsPerHour: 4 }]);
  });
});

describe("#connect: the hourly schedule", () => {
  const tz = "America/Chicago";
  const schedule = (): ConnectSchedule => ({
    enabled: true,
    accounts: [
      { accountId: "manx", perHour: 3, dailyCap: 72, avoidTimes: ["14:05"] },
      { accountId: "sterling", perHour: 3, dailyCap: 10 },
    ],
  });
  const at = (hhmm: string) => `2026-10-09T${hhmm}:00.000-05:00`;
  const none = () => 0;

  it("starts each account at its own minute, different from hour to hour", () => {
    const minutes = ["2026-10-09T13", "2026-10-09T14", "2026-10-09T15", "2026-10-09T16"].map((hour) => connectStartMinute("manx", hour));
    assert.ok(new Set(minutes).size >= 3, `varies: ${minutes}`);
    assert.ok(minutes.every((minute) => minute >= 0 && minute <= 40));
    const start = connectStartMinute("manx", "2026-10-09T13");
    const before = `2026-10-09T13:${String(Math.max(start - 1, 0)).padStart(2, "0")}:00.000-05:00`;
    if (start > 0) assert.equal(planConnectBatch({ ...schedule(), accounts: [schedule().accounts[0]!] }, { nowIso: before, timeZone: tz, doneToday: none }), undefined);
  });

  it("runs the larger account first, one batch per account per hour", () => {
    const s = schedule();
    const first = planConnectBatch(s, { nowIso: at("13:45"), timeZone: tz, doneToday: () => 39 });
    assert.equal(first?.accountId, "manx");
    s.lastBatchHour = { manx: first!.hourKey };
    assert.equal(planConnectBatch(s, { nowIso: at("13:45"), timeZone: tz, doneToday: () => 9 })?.accountId, "sterling");
    s.lastBatchHour.sterling = first!.hourKey;
    assert.equal(planConnectBatch(s, { nowIso: at("13:45"), timeZone: tz, doneToday: none }), undefined, "both done this hour");
  });

  it("takes 3 on pace, 4 when behind, and never passes the daily cap", () => {
    const only = { ...schedule(), accounts: [{ accountId: "manx", perHour: 3, dailyCap: 72 }] };
    assert.equal(planConnectBatch(only, { nowIso: at("13:59"), timeZone: tz, doneToday: () => 39 })?.max, 3, "13 hours x 3 done");
    assert.equal(planConnectBatch(only, { nowIso: at("13:59"), timeZone: tz, doneToday: () => 30 })?.max, 4, "a lean hour earlier");
    const capped = { ...schedule(), accounts: [{ accountId: "sterling", perHour: 3, dailyCap: 10 }] };
    assert.equal(planConnectBatch(capped, { nowIso: at("13:59"), timeZone: tz, doneToday: () => 9 })?.max, 1);
    assert.equal(planConnectBatch(capped, { nowIso: at("13:59"), timeZone: tz, doneToday: () => 10 }), undefined);
  });

  it("keeps clear of the account's own posts, skips a stopped account, and is off unless enabled", () => {
    const s = schedule();
    assert.equal(planConnectBatch(s, { nowIso: at("13:55"), timeZone: tz, doneToday: none })?.accountId, "sterling", "manx posts at 14:05");
    s.stoppedDay = { sterling: "2026-10-09" };
    assert.equal(planConnectBatch(s, { nowIso: at("13:55"), timeZone: tz, doneToday: none }), undefined);
    assert.equal(planConnectBatch({ ...schedule(), enabled: false }, { nowIso: at("13:59"), timeZone: tz, doneToday: none }), undefined);
  });
});
