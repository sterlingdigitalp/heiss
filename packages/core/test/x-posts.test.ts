import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseXTimelineCell, selectXPostPair } from "../src/x-posts.js";
import { choosePostForEngagement } from "../src/engagement-plan.js";

/**
 * Fixtures are real accessibility labels captured from @thekuchh's profile on
 * 2026-07-28 via the x:target_scan action — not invented shapes.
 */
const PINNED =
  "Pinned. kuch (vibecoding arc) Verified. 1 day ago. 10 Replies. 7 Reposts. 32 Likes. 25K Views";
const NEWEST_QUOTE =
  "kuch (vibecoding arc) Verified quoted EP. Verified. kuch (vibecoding arc) added i read a this DISTRIBUTION guide and my running AI agent with with 23 rules across 6 folders  the agent already handles my content system. Image. 3 hours ago. 4 Replies. 4 Reposts. 19 Likes. 1.4K Views";
const WITH_VIDEO =
  "kuch (vibecoding arc) Verified. only 5 free Claude Code skills you NEED  one command installs the whole kit, then each skill hands off to the next. Video. Duration 27 seconds. 1 day ago. 7 Replies. 1 Repost. 26 Likes. 3.5K Views";
const NO_REPOSTS =
  "kuch (vibecoding arc) Verified. Claude Opus 5 builds $15,000 animated websites FOR CHEAP  full scroll-animation sites, one prompt each. Video. Duration 11 minutes, 42 seconds. 1 day ago. 1 Reply. 17 Likes. 1.6K Views";
const TWO_DAYS =
  "kuch (vibecoding arc) Verified. this is absolutely fucking wild  NVIDIA put 138 frontier models behind one API key. Video. Duration 26 seconds. 2 days ago. 8 Replies. 3 Reposts. 33 Likes. 2.1K Views";

const cell = (index: number, label: string) => ({ index, label });

describe("parsing X timeline rows", () => {
  it("rejects profile chrome, spacers, and Show more", () => {
    for (const junk of ["", "Posts", "Replies", "Reposts", "Videos", "Articles", "Show more"]) {
      assert.equal(parseXTimelineCell(cell(0, junk)), null, `should reject ${JSON.stringify(junk)}`);
    }
  });

  it("parses counts, age, and media from a real post label", () => {
    const post = parseXTimelineCell(cell(15, WITH_VIDEO))!;
    assert.equal(post.replies, 7);
    assert.equal(post.reposts, 1);
    assert.equal(post.likes, 26);
    assert.equal(post.views, 3500);
    assert.equal(post.ageHours, 24);
    assert.equal(post.hasMedia, true);
    assert.equal(post.hasReadableText, true);
  });

  it("treats an omitted count as zero rather than unparseable", () => {
    // This real label has no "Reposts" segment at all.
    const post = parseXTimelineCell(cell(21, NO_REPOSTS))!;
    assert.equal(post.reposts, 0);
    assert.equal(post.replies, 1);
    assert.equal(post.likes, 17);
  });

  it("reads abbreviated counts", () => {
    assert.equal(parseXTimelineCell(cell(7, NEWEST_QUOTE))!.views, 1400);
    assert.equal(parseXTimelineCell(cell(6, PINNED))!.views, 25000);
  });

  it("converts relative ages to hours", () => {
    assert.equal(parseXTimelineCell(cell(7, NEWEST_QUOTE))!.ageHours, 3);
    assert.equal(parseXTimelineCell(cell(22, TWO_DAYS))!.ageHours, 48);
  });

  it("flags pinned and quote posts", () => {
    assert.equal(parseXTimelineCell(cell(6, PINNED))!.isPinned, true);
    assert.equal(parseXTimelineCell(cell(7, NEWEST_QUOTE))!.isQuote, true);
    assert.equal(parseXTimelineCell(cell(15, WITH_VIDEO))!.isPinned, false);
  });

  it("keeps quote posts engageable — they carry the author's own words", () => {
    assert.equal(parseXTimelineCell(cell(7, NEWEST_QUOTE))!.isRepost, false);
  });
});

describe("choosing the candidate pair from a profile", () => {
  // Rows exactly as they arrive: header, tab strip, pinned, then the timeline.
  const rows = [
    cell(0, ""), cell(1, "Posts"), cell(2, "Replies"), cell(3, "Reposts"),
    cell(4, "Videos"), cell(5, "Articles"),
    cell(6, PINNED),
    cell(7, NEWEST_QUOTE),
    cell(15, WITH_VIDEO),
    cell(21, NO_REPOSTS),
    cell(13, "Show more"),
    cell(22, TWO_DAYS),
  ];

  it("never mistakes the pinned post for the most recent", () => {
    const pair = selectXPostPair(rows);
    // The pinned row is FIRST on screen and a day old; the real newest is 3h.
    assert.equal(pair.pinned?.index, 6);
    assert.equal(pair.mostRecent?.index, 7);
    assert.equal(pair.mostRecent?.ageHours, 3);
    assert.equal(pair.preceding?.index, 15);
  });

  it("excludes chrome from the post list entirely", () => {
    const pair = selectXPostPair(rows);
    assert.deepEqual(pair.posts.map((p) => p.index), [7, 15, 21, 22]);
  });

  it("feeds the selection rule, which keeps the newest here", () => {
    const pair = selectXPostPair(rows);
    const choice = choosePostForEngagement(pair.mostRecent, pair.preceding);
    // Newest has 4+4+19=27; preceding has 7+1+26=34 — under the 3x bar.
    assert.equal(choice.post?.index, 7);
    assert.equal(choice.reason, "most_recent");
  });

  it("handles a profile with no posts at all", () => {
    const pair = selectXPostPair([cell(0, ""), cell(1, "Posts")]);
    assert.equal(pair.mostRecent, null);
    assert.equal(pair.preceding, null);
  });
});
