/**
 * 合成提示续跑（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * LargeFileRepair 决定续跑时：按 decision.strip 剥离尾部消息 → 压入 transient
 * 合成提示 → 必要时抬升 config.maxOutputTokens → 返回 turn_continued 事件；
 * decision.type === "stop" 则直接构造终止结果。恢复链各步（noToolCalls /
 * toolCallExecution / modelErrorRecovery / responseAssembly / circuitBreaker）
 * 都以回调形式调用本函数。
 */

import type { AgentLoopInput } from "../../protocol/input.js";
import type { PermissionMode } from "../../../permission/index.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import { agentError } from "../../protocol/errors.js";
import type { LargeFileRepairDecision } from "../LargeFileRepair.js";
import { stripTrailingErrorPair } from "../messages.js";
import { createToolErrorLoopStatus } from "../modelErrors.js";
import type { SyntheticPromptOutcome } from "../responseAssembly.js";
import { buildTurnResult } from "../turnExit.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

/** 合成提示续跑依赖袋（AgentLoop 组装注入）。 */
export interface SyntheticPromptDeps {
  readonly config: AgentRuntimeConfig;
  now(): Date;
}

/** 恢复路径缺失工具结果时需要的执行上下文（cwd + 权限模式）。 */
export function missingToolResultRecoveryContext(config: AgentRuntimeConfig): {
  cwd: string;
  permissionMode: PermissionMode;
} {
  return {
    cwd: config.cwd,
    permissionMode: config.permissionMode,
  };
}

export async function continueWithSyntheticPrompt(
  deps: SyntheticPromptDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  decision: LargeFileRepairDecision,
  options: { stripCurrentAssistant?: boolean } = {},
): Promise<SyntheticPromptOutcome> {
  if (decision.type === "stop") {
    const error = agentError("agent_tool_error_loop", decision.reason);
    const result = buildTurnResult(
      input,
      {
        type: "error",
        stopReason: "tool_error",
        usage: state.usage,
        permissionDenials: state.permissionDenials,
        turns: state.turnCount,
        startedAt: state.startedAt,
        finalMessage: state.finalMessage,
        structuredOutput: state.structuredOutput,
        errors: [error],
      },
      deps.now(),
    );
    return { type: "completed", result, status: createToolErrorLoopStatus({ error }) };
  }
  if (options.stripCurrentAssistant !== false) {
    if (decision.strip === "error_pair") {
      state.messages = stripTrailingErrorPair(state.messages);
    } else if (decision.strip === "assistant") {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant") {
        state.messages = state.messages.slice(0, -1);
      }
    }
  }
  state.pushTransientSyntheticPrompt(decision.prompt, decision.purpose);
  if (
    deps.config.maxOutputTokens !== undefined &&
    deps.config.maxOutputTokens < state.largeFileRepair.recommendedMaxOutputTokens
  ) {
    deps.config.maxOutputTokens = state.largeFileRepair.recommendedMaxOutputTokens;
  }
  return {
    type: "continue",
    event: {
      type: "turn_continued",
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: "model_error",
    },
  };
}
