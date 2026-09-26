import type { CuratedTarget } from "./types.js";
import { MAX_CURATED_TARGETS_PER_ACCOUNT } from "./types.js";

/**
 * Curated-target list rules. Kept pure so the CLI, dashboard, and the daily
 * engagement engine all agree on what a valid list looks like without any of
 * them re-implementing the checks.
 */

/** X handles are 1–15 chars of letters/digits/underscore, case-insensitive. */
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** Canonical storage form: a single leading "@" over the raw handle body. */
export function normalizeTargetHandle(raw: string): string {
  return `@${raw.trim().replace(/^@+/, "")}`;
}

/** Case-insensitive identity used for duplicate detection. */
export function targetHandleKey(raw: string): string {
  return normalizeTargetHandle(raw).slice(1).toLowerCase();
}

export interface TargetValidation {
  ok: boolean;
  handle?: string;
  error?: string;
}

export function validateTargetHandle(raw: string): TargetValidation {
  const body = normalizeTargetHandle(raw ?? "").slice(1);
  if (!body) return { ok: false, error: "Enter a handle, e.g. @naval" };
  if (!X_HANDLE.test(body)) {
    return {
      ok: false,
      error: `"${body}" is not a valid X handle (1-15 letters, digits, or underscore)`,
    };
  }
  return { ok: true, handle: `@${body}` };
}

/** Every curated target for one persona, oldest first. */
export function curatedTargetsFor(
  targets: CuratedTarget[],
  accountId: string,
): CuratedTarget[] {
  // Imported targets carry FEGOS's research ranking, and that ranking IS the
  // intended day order — priority 1 gets followed first. Anything unranked
  // (hand-added) sorts after the ranked set, still oldest-added first, so
  // addedAt stays an honest record of when rather than a smuggled ordering.
  return targets
    .filter((target) => target.accountId === accountId)
    .sort((left, right) => {
      const leftRank = left.priority ?? Number.POSITIVE_INFINITY;
      const rightRank = right.priority ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.addedAt.localeCompare(right.addedAt);
    });
}

export type CuratedTargetStatus = "active" | "auto_paused" | "paused";

/**
 * The single source of truth for what state a curated target is in.
 * Selection, capacity, and the desktop's rendering all derive from this so
 * they cannot disagree about whether a target is really active.
 *
 * `active: false` (a manual pause) always wins over an automatic pause: once
 * a target is manually paused, whether it was ever auto-paused is history,
 * not current state.
 */
export function curatedTargetStatus(target: CuratedTarget): CuratedTargetStatus {
  if (!target.active) return "paused";
  if (target.autoPausedAt) return "auto_paused";
  return "active";
}

/** Only active targets are ever engaged; paused ones stay for history. */
export function activeCuratedTargetsFor(
  targets: CuratedTarget[],
  accountId: string,
): CuratedTarget[] {
  // Auto-paused targets stay in the list for history and for `targets resume`,
  // but the rotation must not keep spending days on them.
  return curatedTargetsFor(targets, accountId).filter((target) => curatedTargetStatus(target) === "active");
}

export interface AddTargetCheck {
  ok: boolean;
  handle?: string;
  error?: string;
}

/**
 * Validate a prospective addition against the handle format, the per-persona
 * cap, and existing entries. The cap counts only active targets so a paused
 * substitution never blocks its replacement.
 */
export function checkCuratedTargetAddition(
  targets: CuratedTarget[],
  accountId: string,
  rawHandle: string,
  max: number = MAX_CURATED_TARGETS_PER_ACCOUNT,
): AddTargetCheck {
  const validation = validateTargetHandle(rawHandle);
  if (!validation.ok) return { ok: false, error: validation.error };
  const handle = validation.handle!;
  const existing = curatedTargetsFor(targets, accountId);
  if (existing.some((target) => targetHandleKey(target.handle) === targetHandleKey(handle))) {
    return { ok: false, error: `${handle} is already on this list` };
  }
  // Auto-paused targets do not reserve a capacity slot: they were pulled out
  // of the rotation for lack of engagement, so a persona stuck at 7/7 with
  // auto-paused dead weight could never add a live replacement without first
  // noticing and manually pausing something itself.
  const active = existing.filter((target) => curatedTargetStatus(target) === "active").length;
  if (active >= max) {
    return {
      ok: false,
      error: `This persona already has ${active} active targets (max ${max}). Pause one first.`,
    };
  }
  return { ok: true, handle };
}

/** Consecutive barren attempts before the rotation moves past a target. */
export const BARREN_ATTEMPT_LIMIT = 3;

/**
 * Record what an attempt on a target produced.
 *
 * The rotation orders by least-recently-engaged, so a target that never
 * engages never updates `lastEngagedAt` and stays first in line forever: on
 * 2026-09-18 and again on 2026-09-19 the same persona spent its whole day on
 * @wadefoster and landed nothing. Not every barren attempt is a fault — a
 * target who posts twice a month often has nothing worth engaging — but after
 * a few in a row the persona's day is better spent on someone else.
 */
export function recordTargetAttempt(
  target: CuratedTarget,
  outcome: { engaged: boolean; reason: string; nowIso: string },
  limit = BARREN_ATTEMPT_LIMIT,
): { barrenAttempts: number; autoPausedNow: boolean } {
  if (outcome.engaged) {
    target.barrenAttempts = 0;
    return { barrenAttempts: 0, autoPausedNow: false };
  }
  const barrenAttempts = (target.barrenAttempts ?? 0) + 1;
  target.barrenAttempts = barrenAttempts;
  const autoPausedNow = barrenAttempts >= limit && !target.autoPausedAt;
  if (autoPausedNow) {
    target.autoPausedAt = outcome.nowIso;
    target.autoPauseReason = `${barrenAttempts} attempts without engaging (last: ${outcome.reason})`;
  }
  return { barrenAttempts, autoPausedNow };
}

/** Undo an automatic pause — `targets resume` and any manual reactivation. */
export function clearAutoPause(target: CuratedTarget): void {
  delete target.autoPausedAt;
  delete target.autoPauseReason;
  target.barrenAttempts = 0;
}
