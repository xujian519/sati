/**
 * 压缩执行器：统一 `tryAutoCompact` 的参数组装、compacted 结果处理（替换
 * messages + 落压缩边界快照 + 可选 auto_compact 事件）与失败降级（记日志 +
 * 可选 truncateHeadKeepRatio 兜底）。抽取自 AgentLoop（issue #147 / TD-SIZE-001）。
 *
 * 调用点差异（request 重建 / context_budget 事件 / 外层 turn_continued）保留在
 * 调用点；本模块只负责"压一次并把状态与产物安顿好"。无 `tryAutoCompact` 时
 * 直接返回未压缩。
 */

import { compressIndexRanges } from "../../context/compaction/CompactionEngine.js";
import type { AutoCompactResult, TokenBudgetSnapshot } from "../../context/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { createLogger } from "../../telemetry/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import { markCompactReplacementMessages, splitTransientPrompts, truncateHeadKeepRatio } from "./messages.js";
import type { TokenBudgetEvaluator } from "./modelRequest.js";
import type { TurnRuntimeState } from "./turnRuntimeState.js";

const agentLogger = createLogger("agent");
const autoCompactLogger = createLogger("agent:auto-compact");

/** 压缩执行器入参（`stage` 供失败日志与调用点区分）。 */
export type AutoCompactOptions = {
  stage: "pre-routing" | "post-routing" | "model-error-recovery";
  maxContextTokens?: number;
  reservedOutputTokens: number;
  /** 预算评估器：决定是否压缩以及压到多少（`createBudgetEvaluator` 产物）。 */
  budgetEvaluator?: TokenBudgetEvaluator;
  emitAutoCompactEvent?: boolean;
  fallbackTruncateRatio?: number;
};

/** 压缩结论：`compacted` 为真时 messages 已被替换、快照已落盘。 */
export type AutoCompactOutcome = { compacted: boolean; snapshot?: TokenBudgetSnapshot };

/** 压缩执行器的调用面（ctx 由宿主注入）。 */
export type AutoCompactRunner = (
  state: TurnRuntimeState,
  input: AgentLoopInput,
  options: AutoCompactOptions,
) => AsyncGenerator<AgentEvent, AutoCompactOutcome, unknown>;

function logAutoCompactFailure(stage: string, input: { sessionId: string; turnId: string }, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  autoCompactLogger.warn(`${stage} failed sessionId=${input.sessionId} turnId=${input.turnId}: ${message}`);
}

export async function* runAutoCompact(
  contextRuntime: AgentContextRuntime | undefined,
  state: TurnRuntimeState,
  input: AgentLoopInput,
  options: AutoCompactOptions,
): AsyncGenerator<AgentEvent, AutoCompactOutcome, unknown> {
  const ctx = contextRuntime;
  if (!ctx?.tryAutoCompact) {
    return { compacted: false };
  }
  // transient synthetic prompts（恢复提示）从未落库，但可能仍在
  // state.messages 中（上一轮 assemble 阶段才 expire，而本阶段在下一轮
  // prepareModelCall 开头先于 assemble 执行）。压缩输入若包含它们，遮蔽
  // 重建序列（transcript 投影）会缺这些消息导致 shadowedRanges 错位。
  // 压缩前剥离，压缩产物后再追加回末尾（模型尚未消费它们）。
  const { persistent: compactInputMessages, transient: transientPrompts } = splitTransientPrompts(state.messages);
  try {
    const compact = await ctx.tryAutoCompact({
      sessionId: input.sessionId,
      turnId: input.turnId,
      messages: compactInputMessages,
      abortSignal: input.abortSignal,
      ...(options.maxContextTokens !== undefined ? { maxContextTokens: options.maxContextTokens } : {}),
      reservedOutputTokens: options.reservedOutputTokens,
      lastUsage: state.lastModelUsage,
      ...(options.budgetEvaluator !== undefined ? { budgetEvaluator: options.budgetEvaluator } : {}),
    });
    if (compact.type === "compacted") {
      state.messages = [...compact.messages, ...transientPrompts];
      await persistCompactSnapshot(input, compact);
      if (options.emitAutoCompactEvent !== false) {
        yield {
          type: "turn_continued",
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: "auto_compact",
        };
      }
      return { compacted: true, snapshot: compact.snapshot };
    }
    if (options.fallbackTruncateRatio !== undefined) {
      state.messages = [
        ...truncateHeadKeepRatio(compactInputMessages, options.fallbackTruncateRatio),
        ...transientPrompts,
      ];
    }
    return { compacted: false, snapshot: compact.snapshot };
  } catch (error: unknown) {
    logAutoCompactFailure(options.stage, input, error);
    if (options.fallbackTruncateRatio !== undefined) {
      state.messages = [
        ...truncateHeadKeepRatio(compactInputMessages, options.fallbackTruncateRatio),
        ...transientPrompts,
      ];
    }
    return { compacted: false };
  }
}

/** 落压缩边界快照（transcript 投影 / UI 压缩边界行依赖它）。 */
export async function persistCompactSnapshot(
  input: AgentLoopInput,
  compact: Extract<AutoCompactResult, { type: "compacted" }>,
): Promise<void> {
  if (!input.onCompactPersisted || !compact.result) {
    return;
  }
  const shadowedRanges = compact.result.shadowedMessageIndexes
    ? compressIndexRanges(compact.result.shadowedMessageIndexes)
    : undefined;
  const boundary: AgentControlBoundaryTranscriptEntry["boundary"] = {
    kind: "compact",
    subtype: "compact_boundary",
    compactMetadata: {
      compactionId: compact.result.compactionId,
      trigger: compact.result.trigger,
      preTokens: compact.result.preTokens,
      ...(compact.result.postTokens !== undefined ? { postTokens: compact.result.postTokens } : {}),
      messagesSummarized: compact.result.messagesSummarized,
      ...(shadowedRanges !== undefined && shadowedRanges.length > 0 ? { shadowedRanges } : {}),
      extra: {
        tier: compact.tier,
        summarySucceeded: compact.result.error === undefined,
        status: compact.result.status,
      },
    },
  };
  await Promise.resolve(
    input.onCompactPersisted({
      boundary,
      messages: markCompactReplacementMessages(compact.messages),
    }),
  ).catch(error => agentLogger.warn("onCompactPersisted failed:", error));
}
