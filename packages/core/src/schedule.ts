import { randomUUID } from "node:crypto";
import type { ScheduleSlot, SocialAccount } from "./types.js";
import { canPost } from "./lifecycle.js";

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export function createSlot(
  accountId: string,
  timeOfDay: string,
  enabled = true,
): ScheduleSlot {
  if (!/^\d{2}:\d{2}$/.test(timeOfDay)) {
    throw new ScheduleError(`Invalid timeOfDay ${timeOfDay}; expected HH:mm`);
  }
  return {
    id: randomUUID(),
    accountId,
    timeOfDay,
    enabled,
  };
}

/**
 * Find accounts that have an open schedule slot for the given local HH:mm
 * and are eligible to post. Used to fill configured time slots automatically.
 *
 * `alreadyFilledAccountIds` is the set of accounts that already filled this
 * slot for the current planning window (typically this run tick, and/or
 * same calendar day + timeOfDay). Must NOT be "every account that ever posted".
 */
export function accountsNeedingSlotFill(
  accounts: SocialAccount[],
  slots: ScheduleSlot[],
  timeOfDay: string,
  alreadyFilledAccountIds: Set<string> = new Set(),
): SocialAccount[] {
  const open = slots.filter((s) => s.enabled && s.timeOfDay === timeOfDay);
  const accountIds = new Set(open.map((s) => s.accountId));
  return accounts.filter(
    (a) =>
      accountIds.has(a.id) &&
      canPost(a) &&
      !alreadyFilledAccountIds.has(a.id),
  );
}

/** YYYY-MM-DD from an ISO timestamp (UTC date component). */
export function calendarDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Accounts that already filled `timeOfDay` on `day` (completed post sessions).
 * Used so a second Cloud Drop on a later day still posts, while the same
 * slot on the same day is not double-filled unless a new run day arrives.
 *
 * Scope is day + slot only — never lifetime posted status.
 */
export function accountsFilledSlotOnDay(
  sessions: { accountId: string; kind: string; status: string; completedAt?: string; slotTimeOfDay?: string; checkpoint: { posted?: boolean } }[],
  timeOfDay: string,
  day: string,
): Set<string> {
  const filled = new Set<string>();
  for (const s of sessions) {
    if (s.kind !== "post") continue;
    if (s.status !== "completed") continue;
    if (!s.checkpoint.posted) continue;
    if (!s.completedAt || calendarDay(s.completedAt) !== day) continue;
    // Sessions without slotTimeOfDay (legacy) count for any slot that day
    if (s.slotTimeOfDay !== undefined && s.slotTimeOfDay !== timeOfDay) continue;
    filled.add(s.accountId);
  }
  return filled;
}

/**
 * Match a claimed queue item to the next account that needs a slot filled.
 * Prefers accounts listed on the queue item that also have open slots.
 */
export function pickAccountForQueueItem(
  accountIdsOnItem: string[],
  eligible: SocialAccount[],
): SocialAccount | undefined {
  const eligibleIds = new Set(eligible.map((a) => a.id));
  for (const id of accountIdsOnItem) {
    if (eligibleIds.has(id)) {
      return eligible.find((a) => a.id === id);
    }
  }
  return undefined;
}

/** Parse HH:mm to minutes since midnight for ordering. */
export function timeToMinutes(timeOfDay: string): number {
  const [h, m] = timeOfDay.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function nextOpenSlot(
  slots: ScheduleSlot[],
  accountId: string,
  fromTime: string,
): ScheduleSlot | undefined {
  const mins = timeToMinutes(fromTime);
  const mine = slots
    .filter((s) => s.accountId === accountId && s.enabled)
    .sort((a, b) => timeToMinutes(a.timeOfDay) - timeToMinutes(b.timeOfDay));
  return (
    mine.find((s) => timeToMinutes(s.timeOfDay) >= mins) ?? mine[0]
  );
}
