/**
 * TurnRuntimeState：run() 单次执行内跨迭代可变状态的收拢容器。
 *
 * run() while 循环原本用 30+ 闭包变量（messages/turnCount/usage/恢复守卫/
 * 电路断路器计数/sticky 路由信息等）跨迭代共享状态。轮次 4 把这些变量集中到
 * 本类，阶段方法（runTurnGuards / prepareModelCall / ...）通过 state 共享，
 * 替代闭包与逐方法传参。常量（恢复上限）随迁至此模块顶层导出。
 */

import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { InvalidateStickyResult } from "../../router/index.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentPermissionDenial } from "../protocol/result.js";
import { LargeFileRepair } from "./LargeFileRepair.js";
import { removeTransientPromptsById } from "./messages.js";

/** 多轮 max_output_reached 续写恢复的上限（超过即放弃恢复、走错误面）。 */
export const MAX_OUTPUT_RECOVERY_LIMIT = 50;
/** 连续空响应（thinking-only）达到该次数后停止重试。 */
export const MAX_CONSECUTIVE_EMPTY = 3;
/** JSON 自纠错重试上限。 */
export const MAX_JSON_SELF_CORRECT_RETRIES = 3;
/** 相同 invalid_tool_input 指纹连续出现的熔断阈值。 */
export const MAX_SAME_INVALID_FINGERPRINT = 3;
/** 流中断（streamInterruption 错误）恢复上限（超过即走错误面）。 */
export const MAX_STREAM_INTERRUPTION_RECOVERIES = 2;

export class TurnRuntimeState {
  messages: CanonicalMessage[];
  turnCount: number;
  usage: CanonicalUsage;
  lastModelUsage: CanonicalUsage | undefined;
  permissionDenials: AgentPermissionDenial[];
  structuredOutput: unknown;
  finalMessage: CanonicalMessage | undefined;
  readonly startedAt: string;
  /** DoomLoop Fatal 信号的原因；非 undefined 时下一轮模型请求前终止 turn。 */
  doomLoopFatalReason: string | undefined;
  // 单发恢复守卫（每 turn 内最多生效一次的开关）
  hasAttemptedCompact = false;
  hasAttemptedOutputRetry = false;
  hasAttemptedEmptyRetry = false;
  hasAttemptedToolCallRetry = false;
  hasAttemptedReasoningContentRetry = false;
  // 恢复计数
  maxOutputRecoveryCount = 0;
  consecutiveEmptyCount = 0;
  jsonSelfCorrectCount = 0;
  streamInterruptionRecoveryCount = 0;
  // 电路断路器（invalid_tool_input 指纹）
  lastInvalidFingerprint: string | undefined;
  sameInvalidFingerprintCount = 0;
  hasUsedInvalidGracePeriod = false;
  lastToolFailureFingerprint: string | undefined;
  // transient synthetic prompts
  private transientPromptCounter = 0;
  readonly activeTransientPromptIds = new Set<string>();
  // 「模型可见 = 已记录」同 turn 去重：工具循环每轮都重新收集注入段落，
  // 相同 source+text 只落库一次，避免 transcript 膨胀为 N 份重复条目。
  readonly reportedInjectionKeys = new Set<string>();
  // sticky routing（路由器 token-saver 分层信息）
  readonly stickyInfo: InvalidateStickyResult | undefined;
  previousTier: string | undefined;
  // 大文件修复（turn 级有状态实例）
  readonly largeFileRepair: LargeFileRepair;
  private readonly uuid: (() => string) | undefined;

  constructor(
    input: AgentLoopInput,
    dependencies: { uuid?: () => string; invalidateSticky?: (sessionId: string) => InvalidateStickyResult },
    startedAt: string,
  ) {
    this.messages = [...input.messages];
    this.turnCount = 1;
    this.usage = {};
    this.permissionDenials = [];
    this.startedAt = startedAt;
    this.largeFileRepair = new LargeFileRepair();
    this.uuid = dependencies.uuid;
    const sticky = dependencies.invalidateSticky?.(input.sessionId);
    this.stickyInfo = sticky;
    this.previousTier = sticky?.previousTier;
  }

  /** 注入一条 transient synthetic prompt（模型恢复提示），记录 transientId 供后续移除。 */
  pushTransientSyntheticPrompt(prompt: string, purpose: string): void {
    const transientId = this.uuid?.() ?? `transient-${++this.transientPromptCounter}`;
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
      metadata: { synthetic: true, transient: true, transientId, purpose },
    });
    this.activeTransientPromptIds.add(transientId);
  }

  /** 从 messages 中移除已消费的 transient synthetic prompts（模型已看到它们之后）。 */
  expireConsumedTransientPrompts(): void {
    if (this.activeTransientPromptIds.size === 0) {
      return;
    }
    this.messages = removeTransientPromptsById(this.messages, this.activeTransientPromptIds);
    this.activeTransientPromptIds.clear();
  }
}
