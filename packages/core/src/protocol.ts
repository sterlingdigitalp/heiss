/** Shared command protocol. Update both values when runner semantics change. */
export const RUNNER_PROTOCOL_VERSION = 2;
export const RUNNER_BUILD = "heiss-runner-2026.07.17.2";

export interface RunnerProtocolInfo {
  protocolVersion: number;
  runnerBuild: string;
  compatible: boolean;
}
