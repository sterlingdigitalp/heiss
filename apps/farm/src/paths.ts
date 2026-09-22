import { join } from "node:path";
import { homedir } from "node:os";

export function defaultDataDir(): string {
  return process.env.HEISS_DATA ?? join(homedir(), ".heiss", "live");
}

export function farmStatePath(dataDir = defaultDataDir()): string {
  return join(dataDir, "farm.json");
}

/**
 * Liveness file for the controller, written by a timer rather than by the tick.
 *
 * The heartbeat in farm.json only advances between tick phases, so a tick
 * running a warmup looks dead for eight minutes or more. On 2026-09-22 the
 * watchdog SIGKILLed a healthy controller mid-engagement on exactly that
 * evidence. A timer keeps writing while the event loop turns — which is the
 * property actually worth checking, since a wedged process stops writing.
 */
export function controllerHeartbeatPath(dataDir = defaultDataDir()): string {
  return join(dataDir, "controller-heartbeat");
}
