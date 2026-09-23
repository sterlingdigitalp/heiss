import { calendarDay } from "./schedule.js";
import type { FarmSession } from "./types.js";

/**
 * Parked (attention) sessions safe to retire automatically: escalated on a
 * runner build that has since been replaced, and on an earlier local day.
 * Sessions without a recorded build are left for a human.
 */
export function retiredAttentionSessions(
  sessions: FarmSession[],
  opts: { nowIso: string; timeZone: string; runnerBuild: string },
): FarmSession[] {
  const today = calendarDay(opts.nowIso, opts.timeZone);
  return sessions.filter((session) => session.status === "checkpointed"
    && session.requiresAttention === true
    && !!session.escalatedOnRunnerBuild
    && session.escalatedOnRunnerBuild !== opts.runnerBuild
    && calendarDay(session.updatedAt, opts.timeZone) < today);
}
