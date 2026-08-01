import type { CuratedTarget } from "./types.js";
import { MAX_CURATED_TARGETS_PER_ACCOUNT } from "./types.js";
import { curatedTargetsFor, normalizeTargetHandle, targetHandleKey } from "./targets.js";

/**
 * Import curated targets from FEGOS, which is the system of record for the
 * source graph. Research happens there; Heiss consumes the result.
 *
 * The mapping is deliberately narrow: FEGOS ranks ten primaries per persona,
 * Heiss engages one target per persona per day, and the cap is seven — so the
 * top seven by priority become the week's rotation and the rest are ignored.
 * Raising the cap would slow every target's turn, so the cap wins and the
 * ranking decides who makes the cut.
 *
 * This is pure: no filesystem, no clock beyond what the caller passes. The CLI
 * reads FEGOS's JSON and applies the plan; everything decided here is testable.
 */

export interface FegosWatchListAccount {
  handle: string;
  priority?: number;
  relevance_score?: number;
  role?: string;
  status?: string;
}

export interface FegosWatchList {
  persona_id: string;
  accounts: FegosWatchListAccount[];
}

/** Minimal shape of a FEGOS fleet entry — only what the mapping needs. */
export interface FegosFleetAccount {
  persona_id?: string;
  niche?: string;
}

export interface HeissAccountRef {
  id: string;
  handle: string;
}

export type TargetChange =
  | { kind: "keep"; handle: string; priority: number; previousPriority?: number }
  | { kind: "add"; handle: string; priority: number; role?: string }
  | { kind: "retire"; handle: string; followed: boolean; engagedCount: number };

export interface PersonaImportPlan {
  accountId: string;
  accountHandle: string;
  personaId: string;
  niche?: string;
  changes: TargetChange[];
  /** Set when the persona cannot be imported; changes will be empty. */
  problem?: string;
}

export interface FegosImportPlan {
  personas: PersonaImportPlan[];
  /** FEGOS accounts with no Heiss persona — legacy entries, reported not applied. */
  unmatchedFleet: string[];
}

/** FEGOS keys fleet entries by bare handle; Heiss stores "@handle". */
function fleetKeyMatches(fleetKey: string, heissHandle: string): boolean {
  return targetHandleKey(fleetKey) === targetHandleKey(heissHandle);
}

/**
 * Top N by priority. FEGOS supplies `priority` explicitly; relevance_score is
 * a tiebreak only, because two sources can share a priority after an edit and
 * a stable order matters more than which of the two wins.
 */
function rankedPrimaries(list: FegosWatchList, limit: number): FegosWatchListAccount[] {
  return [...list.accounts]
    .filter((entry) => (entry.status ?? "ACTIVE").toUpperCase() === "ACTIVE")
    .sort((left, right) =>
      (left.priority ?? Number.POSITIVE_INFINITY) - (right.priority ?? Number.POSITIVE_INFINITY)
      || (right.relevance_score ?? 0) - (left.relevance_score ?? 0)
      || left.handle.localeCompare(right.handle))
    .slice(0, limit);
}

export function planFegosImport(input: {
  fleet: Record<string, FegosFleetAccount>;
  watchLists: FegosWatchList[];
  accounts: HeissAccountRef[];
  existing: CuratedTarget[];
  limit?: number;
}): FegosImportPlan {
  const limit = input.limit ?? MAX_CURATED_TARGETS_PER_ACCOUNT;
  const byPersona = new Map(input.watchLists.map((list) => [list.persona_id, list]));
  const personas: PersonaImportPlan[] = [];
  const unmatchedFleet: string[] = [];

  for (const [fleetKey, fleetAccount] of Object.entries(input.fleet)) {
    const account = input.accounts.find((candidate) => fleetKeyMatches(fleetKey, candidate.handle));
    if (!account) {
      unmatchedFleet.push(fleetKey);
      continue;
    }
    const personaId = fleetAccount.persona_id ?? "";
    const list = byPersona.get(personaId);
    const plan: PersonaImportPlan = {
      accountId: account.id,
      accountHandle: account.handle,
      personaId,
      niche: fleetAccount.niche,
      changes: [],
    };
    if (!list) {
      // Reported, never silently skipped: a persona with no watch list would
      // otherwise look like "no changes needed".
      plan.problem = personaId
        ? `no watch list for persona_id "${personaId}"`
        : "fleet entry has no persona_id";
      personas.push(plan);
      continue;
    }

    const wanted = rankedPrimaries(list, limit);
    const wantedKeys = new Set(wanted.map((entry) => targetHandleKey(entry.handle)));
    const current = curatedTargetsFor(input.existing, account.id).filter((target) => target.active);
    const currentByKey = new Map(current.map((target) => [targetHandleKey(target.handle), target]));

    for (const [index, entry] of wanted.entries()) {
      const key = targetHandleKey(entry.handle);
      const priority = entry.priority ?? index + 1;
      const held = currentByKey.get(key);
      if (held) {
        plan.changes.push({
          kind: "keep",
          handle: normalizeTargetHandle(entry.handle),
          priority,
          ...(held.priority !== undefined && held.priority !== priority
            ? { previousPriority: held.priority }
            : {}),
        });
      } else {
        plan.changes.push({
          kind: "add",
          handle: normalizeTargetHandle(entry.handle),
          priority,
          ...(entry.role ? { role: entry.role } : {}),
        });
      }
    }
    for (const target of current) {
      if (wantedKeys.has(targetHandleKey(target.handle))) continue;
      // Retire, never delete. We may already have followed this person, and
      // the ledger is the only record that we did.
      plan.changes.push({
        kind: "retire",
        handle: target.handle,
        followed: Boolean(target.followedAt),
        engagedCount: target.engagedCount,
      });
    }
    personas.push(plan);
  }

  return { personas, unmatchedFleet };
}

/**
 * Apply a plan by mutating the target list in place.
 *
 * Retired targets are deactivated rather than removed, and surviving targets
 * keep followedAt/engagedCount — re-adding someone we already follow must not
 * make the farm follow them a second time.
 */
export function applyFegosImport(
  targets: CuratedTarget[],
  plan: FegosImportPlan,
  nowIso: string,
  newId: () => string,
): CuratedTarget[] {
  for (const persona of plan.personas) {
    if (persona.problem) continue;
    for (const change of persona.changes) {
      const key = targetHandleKey(change.handle);
      const existing = targets.find((target) =>
        target.accountId === persona.accountId && targetHandleKey(target.handle) === key);
      if (change.kind === "retire") {
        if (existing) existing.active = false;
        continue;
      }
      if (existing) {
        existing.active = true;
        existing.priority = change.priority;
        if (change.kind === "add" && change.role) existing.sourceRole = change.role;
        continue;
      }
      targets.push({
        id: newId(),
        accountId: persona.accountId,
        handle: normalizeTargetHandle(change.handle),
        active: true,
        addedAt: nowIso,
        engagedCount: 0,
        priority: change.priority,
        ...(change.kind === "add" && change.role ? { sourceRole: change.role } : {}),
      });
    }
  }
  return targets;
}
