import type { PostSnapshot } from "./engagement-plan.js";
import { parseEngagementCount } from "./engagement-plan.js";

/**
 * Parse X profile timeline rows out of their iOS accessibility labels.
 *
 * The labels are far more reliable than screen geometry — they carry author,
 * body, media, relative age and engagement counts in one string, and they
 * survive the layout changes that repeatedly broke coordinate-based reading.
 * Observed shape (suffix is what matters):
 *
 *   [Pinned. ] <author> [Verified] [quoted <other>] <body>
 *   [Image. | Video. Duration 27 seconds. ] <age> ago. N Replies. N Reposts. N Likes. N Views
 *
 * Two traps encoded here, both seen live on a real profile:
 *   - A pinned post sorts FIRST but is not the newest (a pinned post one day
 *     old sat above a three-hour-old one), so "first row" != "most recent".
 *   - Zero counts are omitted entirely rather than rendered as 0, so a missing
 *     segment means none, not unparseable.
 */

export interface XTimelineCell {
  index: number;
  label: string;
  hittable?: boolean;
}

export interface ParsedXPost extends PostSnapshot {
  index: number;
  isPinned: boolean;
  /** The target quote-tweeting someone: still their own commentary. */
  isQuote: boolean;
  hasMedia: boolean;
  views: number;
  bodyText: string;
  /**
   * Distinctive slice of the body used to re-find this exact post on device.
   * Row indexes shift the moment the target posts again, so engagement locates
   * its target by content and refuses if it cannot find it.
   */
  matchText: string;
}

const AGE = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;
const AGE_G = new RegExp(AGE.source, "gi");
const AGE_HOURS: Record<string, number> = {
  second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730, year: 8760,
};

/**
 * X renders a relative age ("2 hours ago") only for very recent posts and
 * switches to an absolute date ("July 27, 2026.") for anything older. Reading
 * only the relative form silently discarded EVERY post on a profile whose
 * newest was a few days old — the profile parsed as one post instead of twelve,
 * and engagement reported "no eligible post" while staring at a full timeline.
 */
const MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];
const ABSOLUTE_DATE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, "gi");

/**
 * Age from an absolute date, or null. The LAST match wins: a body can quote a
 * date ("shipping March 1, 2026"), while the timestamp always sits in the tail
 * just before the engagement counts.
 */
function absoluteAge(label: string, now: Date): { ageHours: number; index: number } | null {
  const matches = [...label.matchAll(ABSOLUTE_DATE)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const month = MONTHS.indexOf(last[1]!.toLowerCase());
  const posted = new Date(Date.UTC(Number(last[3]), month, Number(last[2]), 12));
  if (Number.isNaN(posted.getTime())) return null;
  // Absolute dates carry no clock time, so this is accurate to within a day.
  // The floor matters now that posts are ordered by age: X only falls back to
  // an absolute date once a post is no longer recent, so an absolute-dated post
  // must never sort ahead of one X still renders relatively. Without the floor
  // a same-day date computes as 0 hours and would masquerade as the newest post.
  const raw = (now.getTime() - posted.getTime()) / 3_600_000;
  return { ageHours: Math.max(24, raw), index: last.index! };
}

/** Counts read "10 Replies", "1 Reply", "25K Views"; absent means zero. */
function metric(label: string, singular: string, plural: string): number {
  const match = label.match(new RegExp(`([0-9][0-9.,]*\\s*[KMB]?)\\s+(?:${plural}|${singular})\\b`, "i"));
  return match ? parseEngagementCount(match[1]!.replace(/\s+/g, "")) : 0;
}

/**
 * Parse one row. Returns null for anything that is not a post — the profile
 * header, the Posts/Replies tab strip, "Show more", and empty spacer rows all
 * appear as cells and must not be mistaken for content.
 */
export function parseXTimelineCell(
  cell: XTimelineCell,
  opts: { now?: Date; authorPrefix?: string; authorHandle?: string } = {},
): ParsedXPost | null {
  const label = (cell.label ?? "").trim();
  if (!label) return null;
  const now = opts.now ?? new Date();
  // The real timestamp sits in the tail of the label, after the author/body —
  // never at the start. A relative phrase can also appear IN the body ("posted
  // a fix, finished 2 hours ago, will follow up"), which used to win just
  // because `.match` returns the first hit. Take the LAST relative occurrence
  // and the last absolute occurrence, then let whichever sits FURTHER RIGHT in
  // the string decide — that is structurally the actual timestamp, since a
  // body-text mention can only ever precede it.
  const ageMatches = [...label.matchAll(AGE_G)];
  const lastAgeMatch = ageMatches[ageMatches.length - 1] ?? null;
  const absolute = absoluteAge(label, now);
  const ageMatch = lastAgeMatch && (!absolute || lastAgeMatch.index! > absolute.index)
    ? lastAgeMatch
    : null;
  const views = metric(label, "View", "Views");
  const likes = metric(label, "Like", "Likes");
  const replies = metric(label, "Reply", "Replies");
  const reposts = metric(label, "Repost", "Reposts");
  // A timestamp — relative OR absolute — is what makes a row a post. Chrome
  // rows ("Posts", "Replies", "Show more", the tab strip) carry none, which is
  // what keeps them out of the results.
  //
  // Metrics are deliberately NOT required. X omits zero counts rather than
  // rendering "0", so a post published minutes ago has a timestamp and nothing
  // else — and requiring a non-zero metric discarded exactly the posts the
  // "engage the most recent" rule exists to find. On 2026-08-14 that made
  // @nateherk return no_eligible_post on every attempt, which the daemon then
  // retried nine times in half an hour.
  if (!ageMatch && !absolute) return null;

  const ageHours = ageMatch
    ? Number(ageMatch[1]) * (AGE_HOURS[ageMatch[2]!.toLowerCase()] ?? 1)
    : absolute!.ageHours;

  const isPinned = /^pinned\b/i.test(label);
  const isQuote = /\bquoted\b/i.test(label);
  const hasMedia = /\b(Image|Video|GIF)\b\.?/i.test(label);

  // Body is everything before the media/age tail, minus the author preamble.
  const tailIndex = ageMatch ? ageMatch.index! : absolute!.index;
  let bodyText = tailIndex > 0 ? label.slice(0, tailIndex) : label;
  bodyText = bodyText
    .replace(/^pinned\.\s*/i, "")
    .replace(/\b(Image|Video)\.\s*(Duration[^.]*\.\s*)?$/i, "")
    .trim();
  // Strip the author preamble. The label opens with the display name, an
  // optional "Verified", and for a quote the quoted author plus "<name> added".
  // Leaving it in makes matchText the AUTHOR, and searching the screen for that
  // matches the profile header — tapping it opens the profile instead of the
  // post, which is exactly what happened live on 2026-07-30.
  // Strip the preamble learned from the profile's other rows first; the
  // narrower rules below still run, and still catch the quote-tweet case.
  const prefix = opts.authorPrefix ?? "";
  if (prefix && bodyText.toLowerCase().startsWith(prefix.toLowerCase())) {
    bodyText = bodyText.slice(prefix.length).trim();
  }
  const added = bodyText.indexOf(" added ");
  if (added >= 0) {
    bodyText = bodyText.slice(added + " added ".length);
  } else {
    const verified = bodyText.search(/\bVerified\.\s*/i);
    if (verified >= 0) {
      bodyText = bodyText.slice(verified).replace(/^\bVerified\.\s*/i, "");
    }
  }
  bodyText = bodyText.trim();

  // Identity comes from content, never position: the row index changes as soon
  // as the target posts again, and re-finding by index would engage whatever
  // slid into that slot.
  const normalizedBody = bodyText.replace(/\s+/g, " ").trim();
  const matchText = normalizedBody.slice(0, 60);
  // The key identifies THIS post uniquely for engagement dedup: it must not
  // collide across different authors, nor across two different posts from the
  // same author that happen to open the same way (a thread starter, a
  // template caption). Earlier this used only the first 60 chars of the body,
  // with no author at all, so two authors whose posts opened identically (or
  // two of one author's posts sharing an opening line) hashed to the same
  // fingerprint and looked like the same post to the dedup store. The author
  // handle plus the FULL normalized body make the key specific to one post.
  //
  // Engagement history stores a one-way hash of this key (xPostTargetKey in
  // engagement.ts), so widening it here means old fingerprints will not match
  // the new keys for posts already engaged before this change. Worst case is
  // one re-visit of an already-liked post, which X reports as already_liked —
  // not a duplicate like or a broken run.
  const authorHandle = (opts.authorHandle ?? "").toLowerCase();
  const key = `x:${authorHandle}:${normalizedBody.toLowerCase()}`;
  return {
    index: cell.index,
    key,
    matchText,
    isPinned,
    isQuote,
    hasMedia,
    likes,
    reposts,
    replies,
    views,
    ageHours,
    bodyText,
    // A quote of someone else is still the target's own words, so it is not
    // treated as a repost; only text-free rows are unusable to the writer.
    isRepost: false,
    hasReadableText: bodyText.length >= 20,
  };
}

export interface XPostPair {
  mostRecent: ParsedXPost | null;
  preceding: ParsedXPost | null;
  /** Everything parsed as a post, newest first, pinned excluded. */
  posts: ParsedXPost[];
  pinned: ParsedXPost | null;
}

/**
 * Reduce a profile's rows to the two candidates the selection rule compares.
 *
 * Pinned posts are pulled out rather than dropped: they are legitimate content
 * but must never be mistaken for the newest post, which is exactly the error a
 * naive "first row wins" would make.
 */
/**
 * Every row on one profile opens with the same author preamble, so the longest
 * prefix shared by the post rows IS that preamble — no need to be told the
 * display name.
 *
 * The narrower rules ("Verified.", "<name> added") miss an unverified author
 * whose display name is a tagline. Live on 2026-08-01, @onfly_design's rows
 * left matchText as "Onfly | Site in 24hrs. Typography is sexy." — the needle
 * then matched the PROFILE HEADER, the tap hit the header instead of a post,
 * and the like failed with post_did_not_open.
 */
function sharedAuthorPrefix(labels: string[]): string {
  const cleaned = labels.map((label) => label.replace(/^pinned\.\s*/i, ""));
  if (cleaned.length < 2) return "";
  let prefix = cleaned[0]!;
  for (const label of cleaned.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < label.length && prefix[i] === label[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) return "";
  }
  // Cut back to a sentence boundary: without this, two posts that happen to
  // open with the same word would strip half of a real sentence.
  const cut = prefix.lastIndexOf(". ");
  if (cut < 0) return "";
  const trimmed = prefix.slice(0, cut + 2);
  // A preamble is a name and maybe a badge. Anything long is shared body text.
  return trimmed.length <= 80 ? trimmed : "";
}

export function selectXPostPair(
  cells: XTimelineCell[],
  opts: { now?: Date; authorHandle?: string } = {},
): XPostPair {
  // Two passes: identify the post rows, learn the author preamble from them,
  // then re-parse with it stripped.
  const firstPass = cells
    .map((cell) => ({ cell, post: parseXTimelineCell(cell, opts) }))
    .filter((row) => row.post !== null);
  const authorPrefix = sharedAuthorPrefix(firstPass.map((row) => row.cell.label ?? ""));
  const parsed = firstPass
    .map((row) => parseXTimelineCell(row.cell, { ...opts, authorPrefix }))
    .filter((post): post is ParsedXPost => post !== null);
  const pinned = parsed.find((post) => post.isPinned) ?? null;
  // Order by age, not by the order the accessibility tree happened to return.
  // X lists a profile reverse-chronologically so the two usually agree, and the
  // sort is stable so equal ages keep X's own order — but "most recent" is the
  // rule engagement actually depends on, and it should be derived from the
  // timestamp we already parse rather than assumed from row position.
  const posts = parsed
    .filter((post) => !post.isPinned)
    .sort((left, right) =>
      // An unknown age sorts LAST, never first: a row we could not date must
      // not be able to claim it is the most recent post.
      (left.ageHours ?? Number.POSITIVE_INFINITY) - (right.ageHours ?? Number.POSITIVE_INFINITY));
  return {
    mostRecent: posts[0] ?? null,
    preceding: posts[1] ?? null,
    posts,
    pinned,
  };
}
