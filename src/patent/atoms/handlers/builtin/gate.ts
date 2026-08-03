/**
 * 门控域原子：approval-gate（人机审批门，人工介入中断）。
 */

import { type Atom } from "../../atom.js";
import { type StageExecuteInput, type StageHandler, InterruptStageError, getStateString } from "../../handler.js";

export const approvalGateAtom: Atom = {
  name: "approval-gate",
  description: "人机审批门：挂起等待人工确认（返回中断错误，由上层恢复后继续）",
  category: "gate",
  inputSchema: ["review_context", "guardrail_level"],
  outputSchema: [],
};

export class ApprovalGateHandler implements StageHandler {
  readonly name = "approval-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<never> {
    const reviewContext = getStateString(state, "review_context") || "该阶段产出需要人工确认";
    const guardrailLevel = getStateString(state, "guardrail_level") || "high";
    throw new InterruptStageError("approval-gate", reviewContext, {
      guardrail_level: guardrailLevel,
      review_context: reviewContext,
    });
  }
}
