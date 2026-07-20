/** Shared command protocol. Update both values when runner semantics change. */
export const RUNNER_PROTOCOL_VERSION = 2;
export const RUNNER_BUILD = "heiss-runner-2026.07.20.3";

export interface RunnerProtocolInfo {
  protocolVersion: number;
  runnerBuild: string;
  compatible: boolean;
  /** Free bytes the runner reported for its volume; undefined if not reported
   *  (older runner) or negative if the device could not determine it. */
  freeBytes?: number;
}
