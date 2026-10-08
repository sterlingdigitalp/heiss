/**
 * The #connect session loop. It talks to the phone only through `step`, so it
 * runs unchanged against a fake phone in tests.
 */
import {
  connectEligibility, connectFollowConfirmed, connectPostTapPoint, connectReply,
  connectTargetKey, isConnectPostPage, isConnectResultsPage, parseConnectPostPage,
  parseConnectResults, sameConnectHandle, type ScreenLine,
} from "@heiss/core";

export type ConnectStep = (action: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ConnectOutcome {
  handle: string;
  result: "connected" | "rehearsed" | "followed_reply_failed" | "skipped";
  reason?: string;
  reply?: string;
}

export interface ConnectSessionOptions {
  /** People to connect with at most. */
  max: number;
  /** false = rehearsal: everything except tapping Follow and Post. */
  live: boolean;
  ownedHandles: string[];
  /** connectTargetKey fingerprints of everyone already connected with. */
  alreadyConnected: string[];
  query?: string;
  /** Wait between people, in ms; injected so tests do not sleep. */
  pause?: (index: number) => Promise<void>;
  random?: () => number;
  /** Called the moment a follow is confirmed, so it is recorded even if a later step fails. */
  onFollowed?: (handle: string) => void;
  maxScrolls?: number;
}

/** Handles that differ by at most one character once punctuation is dropped. */
function nearlySameHandle(a: string, b: string): boolean {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = clean(a), right = clean(b);
  if (left === right) return true;
  if (left.length !== right.length || left.length < 6) return false;
  let different = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) different += 1;
  return different <= 1;
}

const linesOf = (value: unknown): ScreenLine[] => (Array.isArray(value) ? value as ScreenLine[] : []);

export async function runConnectSession(step: ConnectStep, opts: ConnectSessionOptions): Promise<{
  outcomes: ConnectOutcome[]; stoppedBecause: string;
}> {
  const random = opts.random ?? Math.random;
  const connected = new Set(opts.alreadyConnected);
  const handled = new Set<string>();
  const outcomes: ConnectOutcome[] = [];
  let lastVariant: number | undefined;
  let acted = 0;
  let scrolls = 0;

  const scan = await step("x:connect_scan", { connectQuery: opts.query ?? "filter:blue_verified #connect", connectPages: 1 });
  let page = linesOf((scan.pages as unknown[] | undefined)?.[0]);
  if (!isConnectResultsPage(page)) return { outcomes, stoppedBecause: "search_did_not_open" };

  while (acted < opts.max) {
    // Never act on anything but the search results. A stray tap once left
    // them for the home feed, which then read as "results" (2026-10-08).
    if (!isConnectResultsPage(page)) return { outcomes, stoppedBecause: "left_results_page" };
    const next = parseConnectResults([page])
      .filter((candidate) => !handled.has(candidate.handle.toLowerCase())
        // OCR reads the same handle differently between passes ("@ETraIn_JZ",
        // "@Efrain_Jz"); one letter apart is the same person this session.
        && ![...handled].some((seen) => nearlySameHandle(seen, candidate.handle)))
      .map((candidate) => ({ candidate, point: connectPostTapPoint(page, candidate.handle) }))
      .find((item) => {
        const verdict = connectEligibility(item.candidate, { ownedHandles: opts.ownedHandles, alreadyConnected: connected });
        if (!verdict.ok) {
          handled.add(item.candidate.handle.toLowerCase());
          outcomes.push({ handle: item.candidate.handle, result: "skipped", reason: verdict.reason });
          return false;
        }
        return item.point !== undefined;
      });

    if (!next) {
      if (scrolls >= (opts.maxScrolls ?? 10)) return { outcomes, stoppedBecause: "no_more_candidates" };
      scrolls += 1;
      page = linesOf((await step("x:connect_page", { connectScroll: true })).lines);
      continue;
    }

    const { candidate } = next;
    handled.add(candidate.handle.toLowerCase());
    const open = async (point: { x: number; y: number }) =>
      linesOf((await step("x:connect_open", { connectTapX: point.x, connectTapY: point.y })).lines);
    let shown = await open(next.point!);
    // A first tap on a long post only expands its text; the second opens it.
    if (isConnectResultsPage(shown)) {
      const again = connectPostTapPoint(shown, candidate.handle);
      if (again) shown = await open(again);
    }
    if (isConnectResultsPage(shown)) {
      outcomes.push({ handle: candidate.handle, result: "skipped", reason: "post_did_not_open" });
      page = shown;
      continue;
    }
    // Neither the results nor a post: stop rather than tap anything blind.
    if (!isConnectPostPage(shown)) return { outcomes, stoppedBecause: "unknown_page" };
    const opened = parseConnectPostPage(shown);
    const handle = opened.handle!;
    handled.add(handle.toLowerCase());
    // Back is only ever tapped from a post page, which is where we are now.
    const skip = async (reason: string, as = handle) => {
      outcomes.push({ handle: as, result: "skipped", reason });
      page = linesOf((await step("x:connect_commit", { connectRehearse: true })).lines);
    };
    if (!sameConnectHandle(handle, candidate.handle)) { await skip("opened_a_different_page", candidate.handle); continue; }
    const verdict = connectEligibility({ ...candidate, handle }, { ownedHandles: opts.ownedHandles, alreadyConnected: connected });
    if (!verdict.ok) { await skip(verdict.reason); continue; }
    if (opened.alreadyFollowing || !opened.followButton) { await skip(opened.alreadyFollowing ? "already_following" : "no_follow_button"); continue; }
    const reply = connectReply(candidate.firstName, random(), lastVariant);
    lastVariant = reply.variant;
    if (acted > 0) await opts.pause?.(acted);
    // Like, then reply: both icons share a row, so they share a height.
    const replyInput = (point: { x: number; y: number }) => ({
      connectRehearse: !opts.live, connectReplyX: point.x, connectReplyY: point.y,
      connectLikeX: 0.47, connectLikeY: point.y,
      connectReply: reply.text, connectExpectHandle: handle,
    });
    const followInput = { connectFollowX: opened.followButton.x, connectFollowY: opened.followButton.y };
    let done: Record<string, unknown>;
    if (opened.replyButton) {
      done = await step("x:connect_commit", { ...followInput, ...replyInput(opened.replyButton) });
    } else {
      // A long post pushes the comment bubble off screen. Follow while the
      // button is in view, then scroll the post until the bubble shows.
      const followed = await step("x:connect_commit", { connectRehearse: !opts.live, ...followInput, connectBack: false });
      let bubble: { x: number; y: number } | undefined;
      const stopHere = followed.follow === "already_following" || followed.follow === "unfollow_sheet_stuck";
      for (let scroll = 0; scroll < 3 && !bubble && !stopHere; scroll++) {
        bubble = parseConnectPostPage(linesOf((await step("x:connect_page", { connectScroll: true })).lines)).replyButton;
      }
      const replied = bubble
        ? await step("x:connect_commit", replyInput(bubble))
        : await step("x:connect_commit", { connectRehearse: true });
      done = { ...replied, follow: followed.follow, afterFollow: followed.afterFollow, ...(bubble ? {} : { reply: "no_reply_button" }) };
    }
    page = linesOf(done.lines);
    acted += 1;
    // The Follow button looks the same once followed, so the tap is how we
    // learn it: X answered with an Unfollow sheet, which the runner cancelled.
    if (done.follow === "unfollow_sheet_stuck") {
      outcomes.push({ handle, result: "skipped", reason: "unfollow_sheet_stuck" });
      return { outcomes, stoppedBecause: "unfollow_sheet_stuck" };
    }
    if (done.follow === "already_following") {
      connected.add(connectTargetKey(handle));
      if (opts.live) opts.onFollowed?.(handle);
      outcomes.push({ handle, result: "skipped", reason: "already_following" });
      acted -= 1;
      continue;
    }
    // Record a follow the moment it was tapped, before anything can return:
    // a stop after the tap must not leave a followed person unrecorded.
    const followTapped = opts.live && done.follow === "tapped";
    if (followTapped && connectFollowConfirmed(linesOf(done.afterFollow))) {
      connected.add(connectTargetKey(handle));
      opts.onFollowed?.(handle);
    }
    // The box did not hold exactly the intended reply: nothing was posted, and
    // nothing more should be attempted until someone has looked.
    if (done.reply === "reply_text_mismatch") {
      outcomes.push({ handle, result: followTapped ? "followed_reply_failed" : "skipped", reason: "reply_text_mismatch", reply: reply.text });
      return { outcomes, stoppedBecause: "reply_text_mismatch" };
    }
    if (!opts.live) {
      outcomes.push({ handle, result: "rehearsed", reply: reply.text, reason: done.pasted === true ? "typed_and_verified" : String(done.reply ?? "not_typed") });
      continue;
    }

    if (!connectFollowConfirmed(linesOf(done.afterFollow))) {
      outcomes.push({ handle, result: "skipped", reason: "follow_not_confirmed" });
      // An unconfirmed follow is the first sign of a limit: stop, do not push on.
      return { outcomes, stoppedBecause: "follow_not_confirmed" };
    }
    if (done.reply === "posted") outcomes.push({ handle, result: "connected", reply: reply.text });
    else {
      outcomes.push({ handle, result: "followed_reply_failed", reply: reply.text, reason: String(done.reply ?? "unknown") });
      // A bubble that never scrolled into view is that one post's shape; any
      // other failed reply may be X refusing, so stop.
      if (done.reply !== "no_reply_button") return { outcomes, stoppedBecause: "reply_failed" };
    }
  }
  return { outcomes, stoppedBecause: "reached_max" };
}
