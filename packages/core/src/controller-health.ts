/**
 * Judge the controller from outside itself.
 *
 * Every other alarm in the farm is raised by the controller, so when the
 * controller is the thing that died nothing reports: on 2026-09-18 it crashed
 * at 04:21, launchd could not exec the rebuilt app bundle (exit 78), and the
 * farm sat dead until a person looked. Its heartbeat is already persisted in
 * farm state, so an outside watcher only needs to read a file.
 */

/** Ticks run about once a minute, but one doing real device work takes many
 *  minutes, and the heartbeat only advances between phases. */
export const CONTROLLER_STALE_AFTER_MS = 6 * 60_000;
/** A live process with a stale heartbeat is busy or wedged, not dead. Its own
 *  tick watchdog force-restarts at 25 minutes; past that it never will. */
export const CONTROLLER_WEDGED_AFTER_MS = 28 * 60_000;
/** While it stays down, repeat the alarm at most this often. */
export const CONTROLLER_ALARM_REPEAT_MS = 30 * 60_000;

export interface ControllerHealth {
  alive: boolean;
  ageMs?: number;
  detail: string;
}

/**
 * Judge the controller from its heartbeat and, when known, whether its process
 * still exists.
 *
 * Killing on a stale heartbeat alone is wrong: a tick running a warmup holds
 * for 8+ minutes without advancing it, and on 2026-09-22 the watchdog
 * SIGKILLed a live controller mid-engagement — twice — destroying the work it
 * was protecting. A live process is only declared dead once it is past the
 * point where its own tick watchdog would have restarted it.
 */
export function assessControllerHeartbeat(
  heartbeatAt: string | undefined,
  nowIso: string,
  staleAfterMs = CONTROLLER_STALE_AFTER_MS,
  pidAlive?: boolean,
): ControllerHealth {
  if (!heartbeatAt) return { alive: false, detail: "the controller has never recorded a heartbeat" };
  const age = Date.parse(nowIso) - Date.parse(heartbeatAt);
  if (!Number.isFinite(age)) return { alive: false, detail: `unreadable heartbeat ${heartbeatAt}` };
  // A heartbeat from the future is a clock change, not a dead controller.
  if (age < 0) return { alive: true, ageMs: 0, detail: "heartbeat is ahead of the clock" };
  const minutes = Math.round(age / 60_000);
  if (age <= staleAfterMs) return { alive: true, ageMs: age, detail: `heartbeat ${Math.round(age / 1000)}s ago` };
  if (pidAlive === true && age <= CONTROLLER_WEDGED_AFTER_MS) {
    return { alive: true, ageMs: age, detail: `heartbeat ${minutes} minutes old, but the controller process is running (a long tick)` };
  }
  return {
    alive: false,
    ageMs: age,
    detail: pidAlive === true
      ? `controller process is running but has not ticked for ${minutes} minutes`
      : `no controller heartbeat for ${minutes} minutes`,
  };
}

/** Alarm on the way down, and only occasionally while it stays down. */
export function shouldRaiseControllerAlarm(
  previous: { alive: boolean; notifiedAt?: string } | undefined,
  alive: boolean,
  nowIso: string,
  repeatMs = CONTROLLER_ALARM_REPEAT_MS,
): boolean {
  if (alive) return false;
  if (!previous || previous.alive) return true;
  if (!previous.notifiedAt) return true;
  return Date.parse(nowIso) - Date.parse(previous.notifiedAt) >= repeatMs;
}

/** A pause this long is almost certainly forgotten, not deliberate. */
export const MAINTENANCE_ALARM_AFTER_MS = 2 * 60 * 60_000;

/**
 * A paused farm is exactly as quiet as a dead one. The desktop detach flow
 * sets maintenance and has repeatedly failed to clear it — 2026-08-07 cost a
 * whole window, 2026-08-19 to 09-17 hid four idle weeks, and a controller
 * restart on 2026-09-18 set it again unnoticed.
 */
export function stalePause(
  maintenance: { mode: string; reason?: string; enteredAt?: string } | undefined,
  nowIso: string,
  afterMs = MAINTENANCE_ALARM_AFTER_MS,
): { stale: boolean; detail: string } {
  if (!maintenance || maintenance.mode === "running") return { stale: false, detail: "not paused" };
  const enteredAt = maintenance.enteredAt;
  const age = enteredAt ? Date.parse(nowIso) - Date.parse(enteredAt) : Number.NaN;
  if (!Number.isFinite(age)) return { stale: true, detail: `paused (${maintenance.reason ?? "no reason given"})` };
  if (age < afterMs) return { stale: false, detail: `paused ${Math.round(age / 60_000)} minutes ago` };
  const hours = Math.round(age / 3_600_000);
  return { stale: true, detail: `paused for ${hours}h (${maintenance.reason ?? "no reason given"})` };
}
