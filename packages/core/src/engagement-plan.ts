import type { CuratedTarget } from "./types.js";
import { activeCuratedTargetsFor } from "./targets.js";
import { calendarDay, effectiveDailyTime, localTimeOfDay, timeToMinutes } from "./schedule.js";

/**
 * The daily X engagement decision: which curated target a persona touches
 * today, and which of that target's posts it engages with.
 *
 * Kept entirely pure — no device, no clock, no store — so the cadence rules
 * are testable and the runner only has to report what it sees on screen.
 */

/** "Much greater" engagement for the hotter-post rule. */
export const HOTTER_POST_MULTIPLE = 3;
/** The preceding post only wins while it is still fresh. */
export const HOTTER_POST_MAX_AGE_HOURS = 6;

/**
 * X renders counts abbreviated ("1.2K", "3M"). Anything unparseable reads as
 * 0 so a hidden or unreadable count can never fake a "hotter" post.
 */
export function parseEngagementCount(raw: string | number | undefined | null): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const text = String(raw ?? "").trim().replace(/,/g, "");
  const match = text.match(/^([0-9]*\.?[0-9]+)\s*([KMB])?$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? "").toLowerCase()] ?? 1;
  return Math.floor(value * scale);
}

/** What the runner can actually read off one post on screen. */
export interface PostSnapshot {
  /** Stable per-post fingerprint, used for "have we engaged this before". */
  key: string;
  likes?: string | number;
  reposts?: string | number;
  replies?: string | number;
  /** Hours since posting, from X's relative timestamp ("18m", "2h"). */
  ageHours?: number;
  /** Reposts are someone else's words — never engage them. */
  isRepost?: boolean;
  /** A post with no readable text gives the comment writer nothing to work with. */
  hasReadableText?: boolean;
}

export function postEngagementScore(post: PostSnapshot): number {
  return (
    parseEngagementCount(post.likes) +
    parseEngagementCount(post.reposts) +
    parseEngagementCount(post.replies)
  );
}

export interface PostChoice {
  post: PostSnapshot | null;
  /** Machine-readable reason, surfaced in the session activity log. */
  reason:
    | "most_recent"
    | "preceding_is_hotter"
    | "fell_back_to_preceding"
    | "no_eligible_post";
}

function postIsEligible(post: PostSnapshot | null | undefined, engaged: Set<string>): post is PostSnapshot {
  if (!post) return false;
  if (post.isRepost) return false;
  if (post.hasReadableText === false) return false;
  return !engaged.has(post.key);
}

/**
 * Choose which post to engage with.
 *
 * Default is the most recent post — that is what a person scrolling would land
 * on. The preceding post wins only when it is clearly hotter AND still fresh
 * AND untouched, so a genuinely popular post is not missed. Note the newest
 * post has had less time to gather engagement, which is exactly why the
 * multiple is deliberately high and the age window narrow: without both, the
 * older post would win nearly every time and quietly invert the default.
 */
export function choosePostForEngagement(
  mostRecent: PostSnapshot | null | undefined,
  preceding: PostSnapshot | null | undefined,
  opts: { alreadyEngagedKeys?: Iterable<string> } = {},
): PostChoice {
  const engaged = new Set(opts.alreadyEngagedKeys ?? []);
  const recentOk = postIsEligible(mostRecent, engaged);
  const precedingOk = postIsEligible(preceding, engaged);

  if (recentOk && precedingOk) {
    const fresh = (preceding.ageHours ?? Number.POSITIVE_INFINITY) <= HOTTER_POST_MAX_AGE_HOURS;
    const precedingScore = postEngagementScore(preceding);
    const recentScore = postEngagementScore(mostRecent);
    // `> 0` matters: with both at zero the multiple is trivially satisfied and
    // the older post would win on no evidence at all.
    const hotter = precedingScore > 0 && precedingScore >= HOTTER_POST_MULTIPLE * recentScore;
    if (fresh && hotter) return { post: preceding, reason: "preceding_is_hotter" };
    return { post: mostRecent, reason: "most_recent" };
  }
  if (recentOk) return { post: mostRecent, reason: "most_recent" };
  // The newest post is a repost/unreadable/already touched — the preceding one
  // is the only candidate left, so recency is not required of it.
  if (precedingOk) return { post: preceding, reason: "fell_back_to_preceding" };
  return { post: null, reason: "no_eligible_post" };
}

export interface DailyEngagementPlan {
  target: CuratedTarget | null;
  /** True during the week-one burst, when this target is met for the first time. */
  shouldFollow: boolean;
  reason:
    | "first_follow"
    | "rotation"
    | "no_active_targets"
    | "already_engaged_today"
    | "before_scheduled_time";
}

/**
 * Pick today's target for one persona.
 *
 * Week one walks the curated list in curation order, following one new person
 * per day. Once everyone is followed it rotates to whoever was engaged least
 * recently, so attention spreads evenly. At most one target per persona per
 * day — the human-paced cap the whole plan rests on.
 */
export function planDailyEngagement(
  targets: CuratedTarget[],
  accountId: string,
  nowIso: string,
  timeZone: string,
  schedule?: { timeOfDay?: string; jitterMinutes?: number; seedKey?: string },
): DailyEngagementPlan {
  const active = activeCuratedTargetsFor(targets, accountId);
  if (active.length === 0) {
    return { target: null, shouldFollow: false, reason: "no_active_targets" };
  }
  const today = calendarDay(nowIso, timeZone);
  // An ATTEMPT ends the persona's day, not just a success. A target the runner
  // cannot finish (post not found, detail will not open) fails identically on
  // every retry, so retrying it costs a full navigation each idle tick and
  // starves every other persona. One try per persona per day, win or lose.
  const touchedToday = active.some((target) =>
    [target.lastEngagedAt, target.lastAttemptedAt].some(
      (stamp) => stamp && calendarDay(stamp, timeZone) === today,
    ));
  if (touchedToday) {
    return { target: null, shouldFollow: false, reason: "already_engaged_today" };
  }
  // Hold until this persona's own hour. Without a scheduled time the engagement
  // fires on the first idle tick after the calendar day rolls over, so every
  // persona acts within half an hour of midnight, every night — a pattern no
  // human has. The check is "past the time", never "at the time", so a run
  // missed because the phone was unplugged still happens later that day.
  if (schedule?.timeOfDay) {
    const due = effectiveDailyTime(
      schedule.seedKey ?? accountId, schedule.timeOfDay, schedule.jitterMinutes ?? 0, today,
    );
    if (timeToMinutes(localTimeOfDay(nowIso, timeZone)) < timeToMinutes(due)) {
      return { target: null, shouldFollow: false, reason: "before_scheduled_time" };
    }
  }
  // activeCuratedTargetsFor is already oldest-added first, so this walks the
  // curated day order during the follow burst.
  const unfollowed = active.find((target) => !target.followedAt);
  if (unfollowed) return { target: unfollowed, shouldFollow: true, reason: "first_follow" };

  const leastRecent = [...active].sort((left, right) =>
    (left.lastEngagedAt ?? "").localeCompare(right.lastEngagedAt ?? "")
    || left.addedAt.localeCompare(right.addedAt),
  )[0]!;
  return { target: leastRecent, shouldFollow: false, reason: "rotation" };
}
