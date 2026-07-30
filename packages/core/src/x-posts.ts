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
const AGE_HOURS: Record<string, number> = {
  second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730, year: 8760,
};

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
export function parseXTimelineCell(cell: XTimelineCell): ParsedXPost | null {
  const label = (cell.label ?? "").trim();
  if (!label) return null;
  const ageMatch = label.match(AGE);
  const views = metric(label, "View", "Views");
  const likes = metric(label, "Like", "Likes");
  const replies = metric(label, "Reply", "Replies");
  const reposts = metric(label, "Repost", "Reposts");
  // A real post always carries a relative age plus at least one metric.
  // Chrome rows ("Posts", "Show more") carry neither.
  if (!ageMatch && views === 0 && likes === 0 && replies === 0) return null;
  if (!ageMatch) return null;

  const amount = Number(ageMatch[1]);
  const unit = ageMatch[2]!.toLowerCase();
  const ageHours = amount * (AGE_HOURS[unit] ?? 1);

  const isPinned = /^pinned\b/i.test(label);
  const isQuote = /\bquoted\b/i.test(label);
  const hasMedia = /\b(Image|Video|GIF)\b\.?/i.test(label);

  // Body is everything before the media/age tail, minus the author preamble.
  const tailIndex = label.search(AGE);
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
  const matchText = bodyText.replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    index: cell.index,
    key: `x:${matchText.toLowerCase()}`,
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
export function selectXPostPair(cells: XTimelineCell[]): XPostPair {
  const parsed = cells
    .map(parseXTimelineCell)
    .filter((post): post is ParsedXPost => post !== null);
  const pinned = parsed.find((post) => post.isPinned) ?? null;
  const posts = parsed.filter((post) => !post.isPinned);
  return {
    mostRecent: posts[0] ?? null,
    preceding: posts[1] ?? null,
    posts,
    pinned,
  };
}
