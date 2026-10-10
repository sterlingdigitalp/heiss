/**
 * The "#connect" routine: find fresh posts from a search, follow the author
 * and leave a short reply. This module holds the decisions — who is on a
 * results page, whether they qualify, and what the reply says — so they can be
 * tested without a phone. The runner only reads the screen and taps.
 */
import { createHash } from "node:crypto";

/** Fingerprint under which a connection is remembered; never the handle itself. */
export function connectTargetKey(handle: string): string {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  return `xconnect:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/** One OCR line from the runner: text plus its position on screen (0…1, top-left origin). */
/**
 * Fingerprint for "this account already follows them", learned by opening a
 * post once. Kept apart from connectTargetKey: it is true of one account only
 * and must not stop another account connecting with the same person.
 */
export function connectFollowingKey(handle: string): string {
  return connectTargetKey(handle).replace(/^xconnect:/, "xfollowing:");
}

export interface ScreenLine { t: string; x: number; y: number; w: number; h: number }

export interface ConnectCandidate {
  handle: string;
  displayName: string;
  /** Minutes since posting, from X's relative timestamp ("45s", "12m", "2h"). */
  ageMinutes: number;
  /** Name to address them by, or "" when nothing readable was found. */
  firstName: string;
  /** True when X cut the handle short; the full handle is read on the profile. */
  handleTruncated?: boolean;
}

/** Posts this old or older are skipped; newer is better. */
export const CONNECT_MAX_AGE_MINUTES = 180;

/** The operator's own wordings, verbatim. `<name>` is replaced; two have none. */
export const CONNECT_REPLY_VARIANTS = [
  "followed, let’s connect 🤝",
  "<name> followed you, let’s connect 🤝",
  "followed you 👋🏻, let’s connect🤝",
  "followed you <name>, let’s connect 🤝",
] as const;

const HANDLE = /@([A-Za-z0-9_]{2,15})\b/;
// X renders "· 12m" beside the handle; OCR reads the dot as ·, •, ., - or drops it.
const AGE = /(?:^|[\s·•.\-])(\d{1,2})\s?(s|m|h)\b(?!\w)/;

function ageMinutes(text: string): number | undefined {
  const match = AGE.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2] === "s" ? 0 : match[2] === "m" ? value : value * 60;
}

/**
 * Read the post headers off one or more OCR'd result pages. A header is the
 * line carrying "@handle · 12m"; the display name is the text before the
 * handle on that line, or the line directly above when X wrapped it.
 */
export function parseConnectResults(pages: ScreenLine[][]): ConnectCandidate[] {
  const seen = new Map<string, ConnectCandidate>();
  for (const page of pages) {
    const lines = [...page].sort((a, b) => a.y - b.y || a.x - b.x);
    lines.forEach((line, index) => {
      const handleMatch = HANDLE.exec(line.t);
      if (!handleMatch) return;
      const afterHandle = line.t.slice(handleMatch.index + handleMatch[0].length);
      const age = ageMinutes(afterHandle);
      // A mention inside a post body has no timestamp after it; only headers do.
      if (age === undefined) return;
      // A real header starts at the left edge of the post's text column, where
      // the display name is. OCR also reads text inside a post's images, and a
      // screenshot of a notifications page is full of "@handle · 17m" lines —
      // but inset, never at that edge (2026-10-08: it was tapped five times).
      const atNameColumn = (other: ScreenLine) => other.x > 0.13 && other.x < 0.185;
      const anchored = atNameColumn(line)
        || lines.some((other) => other !== line && Math.abs(other.y - line.y) < 0.012 && atNameColumn(other));
      if (!anchored) return;
      let displayName = line.t.slice(0, handleMatch.index).trim();
      if (!displayName) {
        // X draws "Name  @handle · 7m" on one row, which OCR returns as two
        // pieces; a narrow screen wraps the name onto the row above instead.
        const sameRow = lines
          .filter((other) => other !== line && Math.abs(other.y - line.y) < 0.012 && other.x < line.x)
          .sort((a, b) => b.x - a.x)[0];
        const above = lines.slice(0, index).reverse()
          .find((other) => line.y - (other.y + other.h) >= 0 && line.y - (other.y + other.h) < 0.03
            && Math.abs(other.x - line.x) < 0.08);
        displayName = (sameRow ?? above)?.t.trim() ?? "";
      }
      // X cuts long handles short ("@Gustav_Jou.."); the full one is only on
      // the profile, so a cut handle is a prefix, not an identity.
      const handleTruncated = /^\s*(\.{2,}|…)/.test(afterHandle);
      const handle = `@${handleMatch[1]}`;
      const key = handle.toLowerCase();
      // The same author can appear twice (and once cut short); keep the freshest.
      const sameAuthor = [...seen.keys()].find((other) => other === key
        || ((handleTruncated || seen.get(other)!.handleTruncated) && (other.startsWith(key) || key.startsWith(other))));
      const existing = sameAuthor ? seen.get(sameAuthor) : undefined;
      if (existing && existing.ageMinutes <= age) return;
      if (sameAuthor) seen.delete(sameAuthor);
      seen.set(key, {
        handle, displayName, ageMinutes: age, handleTruncated,
        // A cut handle is not a name; only the display name can supply one.
        firstName: connectFirstName(displayName, handleTruncated ? "" : handle),
      });
    });
  }
  return [...seen.values()].sort((a, b) => a.ageMinutes - b.ageMinutes);
}

/**
 * The first word of the display name, without emoji or decoration; failing
 * that, the leading letters of the handle. "" when neither reads as a name —
 * the caller then uses a wording with no name rather than guessing.
 */
export function connectFirstName(displayName: string, handle: string): string {
  const word = displayName.normalize("NFKC").split(/\s+/)
    .map((part) => part.replace(/[^\p{L}'’-]/gu, ""))
    .find((part) => part.length >= 2);
  if (word && word.length <= 20) return word;
  const fromHandle = /^[A-Za-z]{3,}/.exec(handle.replace(/^@/, ""))?.[0] ?? "";
  return fromHandle;
}

/**
 * Whether to connect with a candidate. `alreadyConnected` holds the
 * fingerprints of everyone ANY persona has already connected with.
 */
export function connectEligibility(
  candidate: ConnectCandidate,
  opts: { ownedHandles: string[]; alreadyConnected: Iterable<string> },
): { ok: boolean; reason: "eligible" | "too_old" | "own_account" | "already_connected" } {
  const key = candidate.handle.toLowerCase();
  if (candidate.ageMinutes >= CONNECT_MAX_AGE_MINUTES) return { ok: false, reason: "too_old" };
  if (opts.ownedHandles.some((owned) => owned.toLowerCase() === key)) return { ok: false, reason: "own_account" };
  // `alreadyConnected` holds connectTargetKey fingerprints.
  if (new Set(opts.alreadyConnected).has(connectTargetKey(candidate.handle))) {
    return { ok: false, reason: "already_connected" };
  }
  return { ok: true, reason: "eligible" };
}

/**
 * Pick a wording: never the same one twice running, and only a named wording
 * when there is a name. `pick` is a 0…1 random number, injected for tests.
 */
export function connectReply(
  firstName: string,
  pick: number,
  lastVariant?: number,
): { text: string; variant: number } {
  const usable = CONNECT_REPLY_VARIANTS
    .map((text, variant) => ({ text, variant }))
    .filter((item) => (firstName ? true : !item.text.includes("<name>")))
    .filter((item, _index, all) => all.length === 1 || item.variant !== lastVariant);
  const chosen = usable[Math.min(usable.length - 1, Math.floor(pick * usable.length))]!;
  return { text: chosen.text.replace("<name>", firstName), variant: chosen.variant };
}

// ── Acting on one person ─────────────────────────────────────────────────

export interface ScreenPoint { x: number; y: number }

const centre = (line: ScreenLine): ScreenPoint => ({ x: line.x + line.w / 2, y: line.y + line.h / 2 });

/**
 * Where to tap on the results page to open a candidate's post: the first line
 * of the post's own text, just under its header. Never the header itself (that
 * opens the profile) and never a line carrying a link or mention.
 */
export function connectPostTapPoint(page: ScreenLine[], handle: string): ScreenPoint | undefined {
  const lines = [...page].sort((a, b) => a.y - b.y || a.x - b.x);
  const key = handle.toLowerCase();
  const header = lines.find((line) => line.t.toLowerCase().includes(key));
  // Too low on the screen: the post text is cut off by the tab bar — scroll first.
  if (!header || header.y > 0.74) return undefined;
  const body = lines.find((line) => line.y > header.y + 0.012 && line.y < header.y + 0.11
    && line.x > 0.12 && line.t.trim().length >= 12
    && !/[@#]|https?:|\.\w{2,3}\//i.test(line.t));
  return body ? centre(body) : undefined;
}

export interface ConnectPostPage {
  /** The author's full handle as shown on the post page. */
  handle?: string;
  /** Present only when the account does not follow the author yet. */
  followButton?: ScreenPoint;
  alreadyFollowing: boolean;
  /** The comment bubble under the post, which opens the reply screen. */
  replyButton?: ScreenPoint;
  /** The heart, third icon in the same row as the comment bubble. */
  likeButton?: ScreenPoint;
}

/**
 * X hides the button at the right of the author row from screen captures and
 * draws a placeholder (it reads "X.com") in its place. The button is "Follow"
 * for someone not yet followed and "Message" once they are, and the
 * placeholder is sized and placed to fit the word under it. Measured on the
 * SE across every capture of 2026-10-08 (10 people):
 *
 *   Follow   width 0.160–0.1658
 *   Message  width 0.1677–0.173   (15 people by 2026-10-09)
 *
 * Twelve of twelve separate on width. Its height on the screen was tried as a
 * second test and dropped: a Follow sat at 0.1231 and a Message at 0.124, too
 * close to tell apart, and it wrongly skipped someone. A width in the narrow
 * gap between the two is treated as already followed: skipping is the safe
 * mistake.
 */
export const CONNECT_FOLLOW_BELOW_WIDTH = 0.1663;
// A confirmed follow measured 0.1677, a hair over the old 0.1675 line.
export const CONNECT_MESSAGE_FROM_WIDTH = 0.1670;

function authorRowPlaceholder(lines: ScreenLine[]): ScreenLine | undefined {
  return lines.find((line) => line.x > 0.6 && line.y > 0.08 && line.y < 0.22 && /^x\.com$/i.test(line.t.trim()));
}

/** Read an opened post page: who wrote it, the Follow button, the icon row. */
export function parseConnectPostPage(lines: ScreenLine[]): ConnectPostPage {
  const top = lines.filter((line) => line.y < 0.36);
  const handleLine = top.find((line) => /^@[A-Za-z0-9_]{2,15}$/.test(line.t.trim()));
  const placeholder = authorRowPlaceholder(lines);
  const isFollow = placeholder !== undefined && placeholder.w < CONNECT_FOLLOW_BELOW_WIDTH;
  // The icon row sits a fixed step under the "time · date · N Views" line; the
  // bubble is its first icon. Without that line on screen there is no safe tap.
  // Match the whole "2:12 PM · 10/8/26 · 62 Views" shape: OCR also reads text
  // inside a post's images, and a screenshot in a post can contain "Views".
  const views = lines.find((line) => line.y > 0.2
    && /\d{1,2}:\d{2}\s?[AP]M/i.test(line.t) && /\d{1,2}\/\d{1,2}\/\d{2}/.test(line.t) && /\bviews?\b/i.test(line.t));
  const viewsY = views ? views.y + views.h / 2 : undefined;
  // The icon row is a fixed 0.05 of the screen under that line. (It was first
  // taken as proportional to how far down the page the line sat, which put the
  // tap below the icons on a post that filled the screen — 2026-10-08.) When
  // the reply or like counts are readable beside the icons, use their height.
  const counts = viewsY === undefined ? [] : lines.filter((line) => /^\d{1,5}[KM]?$/i.test(line.t.trim())
    && line.y + line.h / 2 > viewsY + 0.025 && line.y + line.h / 2 < viewsY + 0.08);
  const bubbleY = viewsY === undefined ? undefined
    : counts.length > 0 ? counts.reduce((sum, line) => sum + line.y + line.h / 2, 0) / counts.length
    : viewsY + 0.05;
  return {
    handle: handleLine?.t.trim(),
    followButton: isFollow ? centre(placeholder!) : undefined,
    alreadyFollowing: !isFollow && handleLine !== undefined,
    replyButton: bubbleY !== undefined && bubbleY < 0.9 ? { x: 0.075, y: bubbleY } : undefined,
    // The row holds five evenly spaced icons: reply, repost, like, bookmark, share.
    likeButton: bubbleY !== undefined && bubbleY < 0.9 ? { x: 0.47, y: bubbleY } : undefined,
  };
}

/**
 * A follow landed when the button is no longer Follow-sized: it has become
 * "Message". Still Follow-sized, or an error on screen, means X did not take
 * it — the first sign of a limit.
 */
export function connectFollowConfirmed(lines: ScreenLine[]): boolean {
  // X's own refusals, as whole phrases. A bare "limit" matched a post that
  // talked about "Claude & Codex limits" and stopped a follow that had landed
  // (2026-10-09). The button's size is the real proof; this only catches X
  // saying no in words.
  const refused = /unable to follow|cannot follow|can['’]t follow|follow limit|reached the limit|try again later|something went wrong|temporarily (limited|restricted)/i;
  if (lines.some((line) => refused.test(line.t))) return false;
  const placeholder = authorRowPlaceholder(lines);
  return placeholder !== undefined && placeholder.w >= CONNECT_MESSAGE_FROM_WIDTH;
}

/** The search results screen: its tab strip (Top … Latest) is on show. */
export function isConnectResultsPage(lines: ScreenLine[]): boolean {
  const strip = lines.filter((line) => line.y > 0.07 && line.y < 0.18).map((line) => line.t.trim().toLowerCase());
  return strip.includes("latest") && strip.includes("top");
}

/** A single post's own page: titled "Post", with the author's handle under it. */
export function isConnectPostPage(lines: ScreenLine[]): boolean {
  return lines.some((line) => line.y < 0.10 && /^post$/i.test(line.t.trim()))
    && parseConnectPostPage(lines).handle !== undefined;
}

/** Same author? OCR drops underscores and X cuts handles short, so compare loosely. */
export function sameConnectHandle(a: string, b: string): boolean {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = clean(a), right = clean(b);
  if (Math.min(left.length, right.length) < 4) return left === right;
  return left.startsWith(right) || right.startsWith(left);
}

// ── Supply: when are there the most fresh posts? ─────────────────────────

/** One scan's reading of how busy "#connect" is right now. */
export interface ConnectSupplySample {
  at: string;
  /** Distinct authors whose post is at most this many minutes old. */
  fresh15: number;
  fresh30: number;
  fresh60: number;
  /** Authors read in the scan, and the oldest post it reached (minutes). */
  read: number;
  reachedMinutes: number;
}

/**
 * Posts per window are counted from the posts' own ages, so the figure does
 * not depend on how often scans run. `fresh30` is only trustworthy when the
 * scan scrolled back at least 30 minutes (`reachedMinutes`).
 */
export function connectSupplySample(candidates: ConnectCandidate[], nowIso: string): ConnectSupplySample {
  const within = (minutes: number) => candidates.filter((candidate) => candidate.ageMinutes <= minutes).length;
  return {
    at: nowIso, fresh15: within(15), fresh30: within(30), fresh60: within(60),
    read: candidates.length,
    reachedMinutes: candidates.reduce((oldest, candidate) => Math.max(oldest, candidate.ageMinutes), 0),
  };
}

export interface ConnectSupplyHour { hour: number; samples: number; postsPerHour: number }

/**
 * Average new posts per hour for each local hour of the day. Uses the widest
 * window each scan actually covered, scaled to an hour, so a scan that only
 * reached 20 minutes back still counts for what it saw.
 */
export function connectSupplyByHour(samples: ConnectSupplySample[], timeZone: string): ConnectSupplyHour[] {
  const hours = new Map<number, number[]>();
  for (const sample of samples) {
    const rate = sample.reachedMinutes >= 60 ? sample.fresh60
      : sample.reachedMinutes >= 30 ? sample.fresh30 * 2
      : sample.reachedMinutes >= 15 ? sample.fresh15 * 4
      : undefined;
    if (rate === undefined) continue;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(sample.at)));
    hours.set(hour, [...(hours.get(hour) ?? []), rate]);
  }
  return [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, rates]) => ({
    hour, samples: rates.length,
    postsPerHour: Math.round((rates.reduce((sum, rate) => sum + rate, 0) / rates.length) * 10) / 10,
  }));
}

// ── Schedule: a few people an hour, at a different minute each hour ───────

export interface ConnectScheduleAccount {
  accountId: string;
  /** People per hour on pace; one more is taken while behind. */
  perHour: number;
  dailyCap: number;
  /** Local "HH:mm" times to stay clear of (the account's own scheduled posts). */
  avoidTimes?: string[];
}

export interface ConnectSchedule {
  enabled: boolean;
  /** In running order: the account with the most followers first. */
  accounts: ConnectScheduleAccount[];
  /** accountId → the local hour ("2026-10-09T14") of its last batch. */
  lastBatchHour?: Record<string, string>;
  /** accountId → the local hour of its first batch of the day; pace is measured from here. */
  paceFrom?: Record<string, string>;
  /** accountId → local day it was stopped on, after X pushed back. */
  stoppedDay?: Record<string, string>;
  stoppedReason?: Record<string, string>;
}

/** Minutes either side of an account's own post during which it does not connect. */
export const CONNECT_AVOID_MINUTES = 15;
/** A batch starts no later than this minute, so it finishes inside its hour. */
export const CONNECT_LATEST_START_MINUTE = 40;

function stableNumber(seed: string): number {
  return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
}

function localParts(iso: string, timeZone: string): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The minute past the hour at which an account's batch starts; different every hour. */
export function connectStartMinute(accountId: string, hourKey: string): number {
  return stableNumber(`${accountId}:${hourKey}`) % (CONNECT_LATEST_START_MINUTE + 1);
}

/**
 * Which account, if any, should run a batch now, and how many people.
 *
 * Each account gets one batch per local hour, starting at that hour's own
 * minute. `doneToday` is how many it has connected with so far today. Behind
 * pace (a lean hour earlier) it takes one more than `perHour`.
 */
export function planConnectBatch(
  schedule: ConnectSchedule | undefined,
  opts: { nowIso: string; timeZone: string; doneToday: (accountId: string) => number },
): { accountId: string; max: number; hourKey: string } | undefined {
  if (!schedule?.enabled) return undefined;
  const now = localParts(opts.nowIso, opts.timeZone);
  const hourKey = `${now.day}T${String(now.hour).padStart(2, "0")}`;
  const nowMinutes = now.hour * 60 + now.minute;
  for (const account of schedule.accounts) {
    if (schedule.stoppedDay?.[account.accountId] === now.day) continue;
    if (schedule.lastBatchHour?.[account.accountId] === hourKey) continue;
    if (now.minute < connectStartMinute(account.accountId, hourKey)) continue;
    const nearOwnPost = (account.avoidTimes ?? []).some((time) => {
      const [hour, minute] = time.split(":").map(Number);
      const gap = Math.abs(nowMinutes - (hour! * 60 + minute!));
      return Math.min(gap, 1440 - gap) <= CONNECT_AVOID_MINUTES;
    });
    if (nearOwnPost) continue;
    const done = opts.doneToday(account.accountId);
    // On pace means perHour for every finished hour since the account's first
    // batch today. Counting from midnight made an account switched on in the
    // afternoon "behind" all day, so it took the extra person every hour.
    const from = schedule.paceFrom?.[account.accountId];
    const startHour = from?.startsWith(now.day) ? Number(from.slice(11, 13)) : now.hour;
    const behind = done < (now.hour - startHour) * account.perHour;
    const max = Math.min(account.perHour + (behind ? 1 : 0), account.dailyCap - done);
    if (max <= 0) continue;
    return { accountId: account.accountId, max, hourKey };
  }
  return undefined;
}
