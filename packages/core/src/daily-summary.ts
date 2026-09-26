/**
 * One end-of-window report of what the farm actually did today.
 *
 * A silent farm and a healthy idle farm look identical from the outside: on
 * 2026-09-18 every engagement failed from 09:08 and nothing said so until a
 * person went looking at 10:28. This runs once per local day, after the last
 * scheduled window, whether the day went well or not — the value is that it
 * always arrives.
 */
import { calendarDay, localTimeOfDay, timeToMinutes } from "./schedule.js";
import type { FarmState } from "./store.js";
import { activeCuratedTargetsFor } from "./targets.js";

/** Minutes after the last scheduled window before the day is reported on. */
export const SUMMARY_GRACE_MINUTES = 45;

export interface DailySummary {
  day: string;
  /** The farm was paused when the day was reported on. */
  paused: boolean;
  warmupsCompleted: number;
  warmupsScheduled: number;
  engagementsAttempted: number;
  /** Personas scheduled for curated engagement today (a time and an active target). */
  engagementsExpected: number;
  /** Expected personas that never attempted an engagement today. */
  engagementsMissed: string[];
  engagementsLanded: number;
  blockedPersonas: string[];
  /** Targets the rotation gave up on today. */
  pausedTargets: string[];
  needsAttention: string[];
  deviceIssues: string[];
  /** One line, phrased for a desktop notification. */
  headline: string;
}

/** Latest local HH:mm the farm is expected to act, or undefined when nothing is scheduled. */
export function lastScheduledMinute(state: Pick<FarmState, "warmupSchedules" | "accounts">): number | undefined {
  const times = [
    ...state.warmupSchedules.filter((schedule) => schedule.enabled).map((schedule) => schedule.timeOfDay),
    ...state.accounts.map((account) => account.curatedEngagementAt).filter((time): time is string => Boolean(time)),
  ].map(timeToMinutes);
  return times.length > 0 ? Math.max(...times) : undefined;
}

export function summaryDue(
  state: Pick<FarmState, "warmupSchedules" | "accounts" | "settings">,
  nowIso: string,
): boolean {
  const timeZone = state.settings.timeZone;
  const day = calendarDay(nowIso, timeZone);
  if (state.settings.notificationKeys[`dailySummary`] === day) return false;
  const last = lastScheduledMinute(state);
  if (last === undefined) return false;
  return timeToMinutes(localTimeOfDay(nowIso, timeZone)) >= last + SUMMARY_GRACE_MINUTES;
}

export function buildDailySummary(state: FarmState, nowIso: string): DailySummary {
  const timeZone = state.settings.timeZone;
  const day = calendarDay(nowIso, timeZone);
  const handleOf = (accountId: string) =>
    state.accounts.find((account) => account.id === accountId)?.handle ?? accountId;
  const ranToday = (stamp?: string) => Boolean(stamp) && calendarDay(stamp!, timeZone) === day;

  const scheduled = state.warmupSchedules.filter((schedule) => schedule.enabled);
  const warmupsCompleted = scheduled.filter((schedule) =>
    ranToday(state.accounts.find((account) => account.id === schedule.accountId)?.lastWarmupAt)).length;

  const touched = state.curatedTargets.filter((target) => ranToday(target.lastAttemptedAt));
  const engagementsLanded = touched.filter((target) => ranToday(target.lastEngagedAt)).length;
  // Compare with what was scheduled, not just what was attempted: a persona
  // that never started used to read as "0/0" and a good day.
  const expectedPersonas = state.accounts.filter((account) => account.curatedEngagementAt
    && activeCuratedTargetsFor(state.curatedTargets, account.id).length > 0);
  const engagementsMissed = expectedPersonas
    .filter((account) => !touched.some((target) => target.accountId === account.id))
    .map((account) => account.handle);

  const blockedPersonas = Object.entries(state.settings.curatedFailures ?? {})
    .filter(([, record]) => record.blockedDay === day)
    .map(([accountId]) => handleOf(accountId));

  const pausedTargets = state.curatedTargets
    .filter((target) => target.autoPausedAt && calendarDay(target.autoPausedAt, timeZone) === day)
    .map((target) => `${handleOf(target.accountId)} → ${target.handle}`);

  const needsAttention = [...new Set(state.sessions
    .filter((session) => session.status === "checkpointed" && session.requiresAttention)
    .map((session) => handleOf(session.accountId)))];

  const deviceIssues = state.devices
    .filter((device) => state.settings.deviceHealth[device.id]?.ok === false)
    .map((device) => `${device.name}: ${state.settings.deviceHealth[device.id]?.detail ?? "unhealthy"}`);

  const paused = state.settings.maintenance.mode !== "running";
  const parts = [
    paused ? `PAUSED (${state.settings.maintenance.reason ?? "no reason given"}) — nothing scheduled ran` : "",
    `warmups ${warmupsCompleted}/${scheduled.length}`,
    `engagements ${engagementsLanded}/${Math.max(expectedPersonas.length, touched.length)}`,
  ];
  if (engagementsMissed.length > 0) parts.push(`never attempted: ${engagementsMissed.join(", ")}`);
  if (blockedPersonas.length > 0) parts.push(`stopped: ${blockedPersonas.join(", ")}`);
  if (pausedTargets.length > 0) parts.push(`targets paused: ${pausedTargets.join(", ")}`);
  if (needsAttention.length > 0) parts.push(`needs you: ${needsAttention.join(", ")}`);
  if (deviceIssues.length > 0) parts.push(deviceIssues.join("; "));

  return {
    day,
    paused,
    warmupsCompleted,
    warmupsScheduled: scheduled.length,
    engagementsAttempted: touched.length,
    engagementsLanded,
    engagementsExpected: expectedPersonas.length,
    engagementsMissed,
    blockedPersonas,
    pausedTargets,
    needsAttention,
    deviceIssues,
    headline: parts.filter(Boolean).join(" · "),
  };
}

/** True when the day fell short of what was scheduled — worth a louder notification. */
export function summaryIsBad(summary: DailySummary): boolean {
  return summary.paused
    || summary.warmupsCompleted < summary.warmupsScheduled
    || summary.engagementsLanded < summary.engagementsAttempted
    || summary.engagementsMissed.length > 0
    || summary.blockedPersonas.length > 0
    || summary.needsAttention.length > 0
    || summary.deviceIssues.length > 0;
}
