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

/** Only active targets are ever engaged; paused ones stay for history. */
export function activeCuratedTargetsFor(
  targets: CuratedTarget[],
  accountId: string,
): CuratedTarget[] {
  return curatedTargetsFor(targets, accountId).filter((target) => target.active);
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
  const active = existing.filter((target) => target.active).length;
  if (active >= max) {
    return {
      ok: false,
      error: `This persona already has ${active} active targets (max ${max}). Pause one first.`,
    };
  }
  return { ok: true, handle };
}
