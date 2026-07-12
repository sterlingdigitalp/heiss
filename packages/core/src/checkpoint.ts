import type { FarmSession, SessionCheckpoint } from "./types.js";

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export function createCheckpoint(): SessionCheckpoint {
  return {
    stepIndex: 0,
    stepsCompleted: [],
    contentAssigned: false,
    posted: false,
  };
}

export function advanceCheckpoint(
  checkpoint: SessionCheckpoint,
  stepName: string,
  extras: Partial<SessionCheckpoint> = {},
): SessionCheckpoint {
  return {
    ...checkpoint,
    ...extras,
    stepIndex: checkpoint.stepIndex + 1,
    stepsCompleted: [...checkpoint.stepsCompleted, stepName],
    lastAction: stepName,
  };
}

/**
 * Resume a checkpointed session: continue from stepIndex without replaying
 * completed steps.
 *
 * If checkpoint.posted is already true (crash after publish, before post-warmup),
 * resume is still allowed — executeSteps skips post:* actions and only finishes
 * remaining warmup. Double-post is prevented by queue item status, not by
 * blocking resume.
 */
export function resumeSession(session: FarmSession): FarmSession {
  if (session.status === "completed") {
    throw new CheckpointError(
      `Session ${session.id} already completed; cannot resume`,
    );
  }
  if (session.status === "failed") {
    throw new CheckpointError(
      `Session ${session.id} failed; cannot resume`,
    );
  }
  if (session.status !== "checkpointed" && session.status !== "running") {
    throw new CheckpointError(
      `Session ${session.id} status ${session.status} is not resumable`,
    );
  }
  return {
    ...session,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
}

export function checkpointSession(session: FarmSession): FarmSession {
  return {
    ...session,
    status: "checkpointed",
    updatedAt: new Date().toISOString(),
  };
}

export function remainingSteps(
  fullScript: string[],
  checkpoint: SessionCheckpoint,
): string[] {
  return fullScript.slice(checkpoint.stepIndex);
}
