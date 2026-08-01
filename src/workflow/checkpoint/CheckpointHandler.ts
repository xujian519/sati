/**
 * Checkpoint handler for human-in-the-loop approval of workflow steps.
 *
 * Adapted from XiaoNuo Agent's `checkpoint-handler.ts`. The engine calls
 * `waitForDecision` when a step declares a `checkpoint` config; hosts (CLI,
 * gateway) implement the interface to route the decision to a human.
 */

import type {
  WorkflowCheckpointDecision,
  WorkflowCheckpointHandler,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStepOutput,
} from "../protocol/types.js";

/** Thrown by hosts that receive a checkpoint but have no decision channel. */
export class WorkflowCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCheckpointError";
  }
}

/** No-op implementation — auto-approves every checkpoint. */
export class NoopCheckpointHandler implements WorkflowCheckpointHandler {
  async waitForDecision(
    _step: WorkflowStep,
    _plan: WorkflowPlan,
    _output: WorkflowStepOutput,
  ): Promise<WorkflowCheckpointDecision> {
    return { action: "approve" };
  }
}
