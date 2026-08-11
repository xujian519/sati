/**
 * 门控域原子：approval-gate（人机审批门，人工介入中断）。
 *
 * 审批闭环（双路径共享同一放行契约）：
 * - 图路径：grantApproval 把放行标记写入检查点 state，resume 重放时本 handler
 *   检测到标记即放行（返回空 delta，不中断）；
 * - manifest 路径（runWorkflow）：宿主按 approvalGrants（stageId 粒度）把标记
 *   注入 handler 执行态，本 handler 同样放行；runWorkflow 仅为放行结果补充
 *   占位输出（APPROVAL_GRANTED_OUTPUT，避免无输出被标记 degraded）。
 * 两条路径的"放行判定"都收敛在本 handler，不分散在外层。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateString,
} from "../../handler.js";

/** 审批门放行标记键：state 中存在该键（truthy）时审批门直接放行。 */
export const APPROVAL_GRANTED_KEY = "__approval_granted__";

/** 已批准审批门在 manifest 路径的占位输出（图路径无输出概念，不需要）。 */
export const APPROVAL_GRANTED_OUTPUT = "APPROVED";

/** 判断 handler 是否为审批门（按 name 契约，供 runWorkflow 注入放行标记）。 */
export function isApprovalGateHandler(handler: StageHandler): boolean {
  return handler.name === "approval-gate";
}

export const approvalGateAtom: Atom = {
  name: "approval-gate",
  description: "人机审批门：挂起等待人工确认（返回中断错误，由上层恢复后继续；已批准时放行）",
  category: "gate",
  inputSchema: ["review_context", "guardrail_level"],
  outputSchema: [],
};

export class ApprovalGateHandler implements StageHandler {
  readonly name = "approval-gate";
  readonly category = "gate" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    // 已批准（grantApproval 写入检查点 state 后 resume，或重跑时注入）：放行不中断。
    if (state[APPROVAL_GRANTED_KEY]) {
      return {};
    }
    const reviewContext = getStateString(state, "review_context") || "该阶段产出需要人工确认";
    const guardrailLevel = getStateString(state, "guardrail_level") || "high";
    throw new InterruptStageError("approval-gate", reviewContext, {
      guardrail_level: guardrailLevel,
      review_context: reviewContext,
    });
  }
}
