import { randomUUID } from "node:crypto";
import type { ScheduleSlot, SocialAccount, WarmupSchedule } from "./types.js";
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
export function calendarDay(iso: string, timeZone = "UTC"): string {
  const parts = zonedParts(iso, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localTimeOfDay(iso: string, timeZone: string): string {
  const parts = zonedParts(iso, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function createWarmupSchedule(
  accountId: string,
  timeOfDay: string,
  jitterMinutes = 8,
  enabled = true,
): WarmupSchedule {
  createSlot(accountId, timeOfDay);
  if (!Number.isInteger(jitterMinutes) || jitterMinutes < 0 || jitterMinutes > 60) {
    throw new ScheduleError("jitterMinutes must be an integer from 0 to 60");
  }
  return { id: randomUUID(), accountId, timeOfDay, jitterMinutes, enabled };
}

export function effectiveWarmupTime(schedule: WarmupSchedule, localDay: string): string {
  const base = timeToMinutes(schedule.timeOfDay);
  const radius = Math.max(0, schedule.jitterMinutes);
  const span = radius * 2 + 1;
  const offset = span === 1 ? 0 : stableHash(`${schedule.accountId}:${localDay}`) % span - radius;
  return minutesToTime(Math.max(0, Math.min(23 * 60 + 59, base + offset)));
}

export function warmupScheduleIsDue(
  schedule: WarmupSchedule,
  nowIso: string,
  timeZone: string,
  lastWarmupAt?: string,
): boolean {
  if (!schedule.enabled) return false;
  const today = calendarDay(nowIso, timeZone);
  if (lastWarmupAt && calendarDay(lastWarmupAt, timeZone) === today) return false;
  return timeToMinutes(localTimeOfDay(nowIso, timeZone)) >= timeToMinutes(effectiveWarmupTime(schedule, today));
}

export function nextWarmupSummary(
  schedules: WarmupSchedule[],
  accounts: SocialAccount[],
  nowIso: string,
  timeZone: string,
): Array<{ accountId: string; handle: string; platform: SocialAccount["platform"]; day: "due now" | "today" | "tomorrow"; timeOfDay: string }> {
  const today = calendarDay(nowIso, timeZone);
  const tomorrow = addUtcDay(today);
  const nowMinutes = timeToMinutes(localTimeOfDay(nowIso, timeZone));
  return schedules.filter((schedule) => schedule.enabled).flatMap((schedule) => {
    const account = accounts.find((candidate) => candidate.id === schedule.accountId);
    if (!account) return [];
    const ranToday = Boolean(account.lastWarmupAt && calendarDay(account.lastWarmupAt, timeZone) === today);
    const todayTime = effectiveWarmupTime(schedule, today);
    const dueNow = !ranToday && timeToMinutes(todayTime) <= nowMinutes;
    return [{
      accountId: account.id,
      handle: account.handle,
      platform: account.platform,
      day: ranToday ? "tomorrow" as const : dueNow ? "due now" as const : "today" as const,
      timeOfDay: ranToday ? effectiveWarmupTime(schedule, tomorrow) : todayTime,
    }];
  }).sort((a, b) => {
    const rank = { "due now": 0, today: 1, tomorrow: 2 } as const;
    return a.day === b.day ? a.timeOfDay.localeCompare(b.timeOfDay) : rank[a.day] - rank[b.day];
  });
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

function minutesToTime(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function zonedParts(iso: string, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute", number> {
  const values: Partial<Record<"year" | "month" | "day" | "hour" | "minute", number>> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso))) {
    if (["year", "month", "day", "hour", "minute"].includes(part.type)) {
      values[part.type as keyof typeof values] = Number(part.value);
    }
  }
  return values as Record<"year" | "month" | "day" | "hour" | "minute", number>;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function addUtcDay(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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
