/**
 * The #connect session loop. It talks to the phone only through `step`, so it
 * runs unchanged against a fake phone in tests.
 */
import {
  connectEligibility, connectFollowConfirmed, connectFollowingKey, connectPostTapPoint, connectReply,
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
  /** connectFollowingKey fingerprints of people THIS account is known to follow already. */
  knownFollowing?: string[];
  /** Called when a post page shows this account already follows its author. */
  onAlreadyFollowing?: (handle: string) => void;
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
  // X cuts a long handle short on the results page, so one can be the start
  // of the other ("@thetechdeck…" and "@thetechdeckusa").
  if (Math.min(left.length, right.length) >= 6 && (left.startsWith(right) || right.startsWith(left))) return true;
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
  const knownFollowing = new Set(opts.knownFollowing ?? []);
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
        // Someone this account is already known to follow is passed over on
        // the results page, without opening their post again.
        const reason = !verdict.ok ? verdict.reason
          : knownFollowing.has(connectFollowingKey(item.candidate.handle)) ? "already_following" : undefined;
        if (reason) {
          handled.add(item.candidate.handle.toLowerCase());
          outcomes.push({ handle: item.candidate.handle, result: "skipped", reason });
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
    // Neither the results nor a post. The usual cause is a "result" that was
    // really text inside a post's image (a screenshot of someone's
    // notifications read as handles and ages), so the tap opened the picture.
    // One back closes it; if that does not return to the results, stop.
    if (!isConnectPostPage(shown)) {
      outcomes.push({ handle: candidate.handle, result: "skipped", reason: "opened_something_else" });
      page = linesOf((await step("x:connect_commit", { connectRehearse: true })).lines);
      if (!isConnectResultsPage(page)) return { outcomes, stoppedBecause: "unknown_page" };
      continue;
    }
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
    if (opened.alreadyFollowing || !opened.followButton) {
      if (opened.alreadyFollowing) { knownFollowing.add(connectFollowingKey(handle)); opts.onAlreadyFollowing?.(handle); }
      await skip(opened.alreadyFollowing ? "already_following" : "no_follow_button");
      continue;
    }
    const reply = connectReply(candidate.firstName, random(), lastVariant);
    lastVariant = reply.variant;
    if (acted > 0) await opts.pause?.(acted);

    // Follow first, then like and reply — the operator's order, and the only
    // one that works: X removes the Follow button from the post once you have
    // replied. So everything the reply needs is PROVEN before the follow: the
    // icon row is found, and the reply screen is opened, checked for the right
    // person, and closed again with nothing typed. Each fault in the first
    // five live runs would have been caught there, before anyone was followed.
    const leave = async () => { page = linesOf((await step("x:connect_commit", { connectRehearse: true })).lines); };
    const findBubble = async (first: { x: number; y: number } | undefined) => {
      let found = first;
      let moved = 0;
      // A long post pushes the icon row off screen: scroll until it shows.
      while (!found && moved < 3) {
        moved += 1;
        found = parseConnectPostPage(linesOf((await step("x:connect_page", { connectScroll: true })).lines)).replyButton;
      }
      return { found, moved };
    };
    const first = await findBubble(opened.replyButton);
    if (!first.found) { await skip("no_reply_button"); continue; }
    const probe = await step("x:connect_commit", {
      connectRehearse: true, connectBack: false, connectProbe: true,
      connectReplyX: first.found.x, connectReplyY: first.found.y, connectExpectHandle: handle,
    });
    if (probe.probe !== "ok") { await skip(String(probe.probe ?? "reply_screen_not_checked")); continue; }

    // Back to the Follow button if the icons needed a scroll.
    let follow = first.moved === 0 ? opened.followButton : parseConnectPostPage(linesOf(probe.lines)).followButton;
    for (let up = 0; !follow && up < 4; up++) {
      follow = parseConnectPostPage(linesOf((await step("x:connect_page", { connectScrollBack: true })).lines)).followButton;
    }
    if (!follow) { await skip("follow_button_not_found"); continue; }

    acted += 1;
    if (!opts.live) {
      const typed = await step("x:connect_commit", {
        connectRehearse: true, connectReplyX: first.found.x, connectReplyY: first.found.y,
        connectReply: reply.text, connectExpectHandle: handle,
      });
      page = linesOf(typed.lines);
      if (typed.reply === "reply_text_mismatch") {
        outcomes.push({ handle, result: "skipped", reason: "reply_text_mismatch", reply: reply.text });
        return { outcomes, stoppedBecause: "reply_text_mismatch" };
      }
      outcomes.push({ handle, result: "rehearsed", reply: reply.text, reason: typed.pasted === true ? "typed_and_verified" : String(typed.reply ?? "not_typed") });
      continue;
    }

    const followed = await step("x:connect_commit", { connectRehearse: false, connectBack: false, connectFollowX: follow.x, connectFollowY: follow.y });
    if (followed.follow !== "tapped" || !connectFollowConfirmed(linesOf(followed.afterFollow))) {
      // The button was not Follow after all, or X did not take it: the first
      // sign of a limit. Nothing was liked or said. Stop.
      outcomes.push({ handle, result: "skipped", reason: String(followed.follow === "tapped" ? "follow_not_confirmed" : followed.follow ?? "follow_not_confirmed") });
      await leave();
      return { outcomes, stoppedBecause: "follow_not_confirmed" };
    }
    connected.add(connectTargetKey(handle));
    opts.onFollowed?.(handle);

    const second = await findBubble(first.moved === 0 ? first.found : undefined);
    const done = second.found
      ? await step("x:connect_commit", {
        connectRehearse: false, connectLikeX: 0.47, connectLikeY: second.found.y,
        connectReplyX: second.found.x, connectReplyY: second.found.y,
        connectReply: reply.text, connectExpectHandle: handle,
      })
      : { ...(await step("x:connect_commit", { connectRehearse: true })), reply: "no_reply_button" };
    page = linesOf(done.lines);
    if (done.reply === "posted") { outcomes.push({ handle, result: "connected", reply: reply.text }); continue; }
    outcomes.push({ handle, result: "followed_reply_failed", reply: reply.text, reason: String(done.reply ?? "unknown") });
    return { outcomes, stoppedBecause: done.reply === "reply_text_mismatch" ? "reply_text_mismatch" : "reply_failed" };
  }
  return { outcomes, stoppedBecause: "reached_max" };
}
