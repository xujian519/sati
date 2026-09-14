/**
 * turn 出口与中止捕获：终止仪式（terminate/abort）、状态事件发射、turn 结果构造与
 * 捕获钩子。抽取自 AgentLoop（issue #147，TD-SIZE-001）；此前 ~25 处终止出口各写一遍
 * captureTurn，漏写会静默丢 turn 记录。
 */
import {
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  type CanonicalMessage,
} from "../../model/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import { safeFinalTextMessage } from "./messages.js";
import { mergeUsage } from "./misc.js";
import {
  createTurnAbortedStatus,
  shouldSurfaceAbortStatus,
  stringifyAbortReason,
  type AgentStatusMessage,
} from "./modelErrors.js";
import type { TokenCapManager } from "./tokenCapManager.js";
import type { TurnRuntimeState } from "./turnRuntimeState.js";

/** run() 阶段方法的统一步进结果：continue 进入下一阶段/下一轮，return 终止 run。 */
export type TurnStepContinue = { kind: "continue" };
export type TurnStepReturn = { kind: "return"; result: AgentTurnResult; messages: CanonicalMessage[] };

/**
 * 阶段内有序步骤的统一结论：`TurnStep*` 表示本步骤已接管，
 * `unhandled` 表示不是本步骤的职责、交给下一条处置路径
 * （恢复链 modelErrorRecovery 与响应装配链 responseAssembly 共用这套词汇）。
 */
export type StageOutcome = TurnStepContinue | TurnStepReturn | { kind: "unhandled" };

/** 构造 `unhandled` 结论（步骤函数"不接管"的默认返回值）。 */
export function unhandled(): StageOutcome {
  return { kind: "unhandled" };
}

/** turn 结果构造参数（sessionId/turnId/completedAt 由构造器补齐）。 */
export type TurnResultOptions = Omit<AgentTurnResult, "sessionId" | "turnId" | "completedAt">;

/**
 * turn 出口与恢复路径的依赖袋：tokenCaps 供恢复策略读写 transient 上限，
 * contextRuntime 供 captureTurn 钩子，now 供 turn 结果构造。
 */
export interface TurnExitDeps {
  readonly tokenCaps: TokenCapManager;
  readonly contextRuntime: AgentContextRuntime | undefined;
  now(): Date;
}

/** 绑定 deps.now 的 turn 结果构造器（与 AgentLoop 的同名私有包装语义一致）。 */
export function makeTurnResultBuilder(deps: TurnExitDeps) {
  return (input: AgentLoopInput, options: TurnResultOptions): AgentTurnResult =>
    buildTurnResult(input, options, deps.now());
}

export function buildTurnResult(input: AgentLoopInput, options: TurnResultOptions, now: Date): AgentTurnResult {
  return {
    ...options,
    sessionId: input.sessionId,
    turnId: input.turnId,
    completedAt: now.toISOString(),
  };
}

export async function emitStatus(input: AgentLoopInput, status: AgentStatusMessage): Promise<AgentEvent> {
  await input.onAgentStatusMessage?.(status);
  return {
    type: "agent_status",
    sessionId: input.sessionId,
    turnId: input.turnId,
    event: status.event,
    detail: status.detail,
  };
}

export function createAbortStatus(input: AgentLoopInput): AgentStatusMessage | undefined {
  if (!shouldSurfaceAbortStatus(input.abortSignal?.reason)) return undefined;
  return createTurnAbortedStatus({ reason: stringifyAbortReason(input.abortSignal?.reason) });
}

export async function captureTurn(
  deps: TurnExitDeps,
  input: AgentLoopInput,
  state: TurnRuntimeState,
  errored: boolean,
): Promise<void> {
  const hook = deps.contextRuntime?.captureTurn;
  if (!hook) return;
  try {
    await hook.call(deps.contextRuntime, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      messages: state.messages,
      errored,
    });
  } catch {
    // captureTurn must never break a turn — context impl already
    // swallows; this catch is defensive.
  }
}

/**
 * 统一 turn 终止仪式：可选的 turn_failed 事件 → captureTurn → turn_completed →
 * return。所有失败/中止/完成出口共用，消除 ~25 处复制粘贴并保证事件顺序
 * 一致（此前各出口散落 captureTurn，漏写会静默丢 turn 记录）。
 */
export async function* terminateTurn(
  deps: TurnExitDeps,
  input: AgentLoopInput,
  state: TurnRuntimeState,
  result: AgentTurnResult,
  options: { emitFailureEvent?: boolean; errored?: boolean } = {},
): AsyncGenerator<AgentEvent, TurnStepReturn, unknown> {
  if (options.emitFailureEvent) {
    yield { type: "turn_failed", sessionId: input.sessionId, turnId: input.turnId, error: result.errors![0]! };
  }
  await captureTurn(deps, input, state, options.errored ?? result.type === "error");
  yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
  return { kind: "return", result, messages: state.messages };
}

/**
 * 中止时捕获已部分生成的 assistant 消息，供 abort 出口复用。经
 * safeFinalTextMessage 过滤：半截工具调用（含文本编码）绝不落库，思考块
 * 不回显——取消时不把不安全的工具片段持久化给用户/转录。
 */
export async function* captureAbortedPartial(
  state: TurnRuntimeState,
  input: AgentLoopInput,
  assembler: ReturnType<typeof createModelMessageAssemblerState>,
): AsyncGenerator<AgentEvent, void, unknown> {
  const partialAssembled = assembleAssistantMessage(assembler);
  const safePartialMessage = safeFinalTextMessage(
    partialAssembled.message,
    partialAssembled.hasPartialTextToolCall || partialAssembled.hasTextFallbackToolCalls,
    partialAssembled.toolCalls,
  );
  if (safePartialMessage) {
    state.finalMessage = safePartialMessage;
    state.messages.push(safePartialMessage);
    state.expireConsumedTransientPrompts();
    state.usage = mergeUsage(state.usage, partialAssembled.usage);
    yield {
      type: "assistant_message",
      sessionId: input.sessionId,
      turnId: input.turnId,
      message: safePartialMessage,
    };
    await input.onDurableMessage?.(safePartialMessage);
  }
}

/**
 * 统一中止终止：createTurnResult(aborted) → 可选 abort 状态 → captureTurn →
 * turn_completed → return。此前 6 处 abort 块中 3 处不发射 abort 状态导致
 * UI 提示不一致，此处统一补齐。
 */
export async function* abortTurn(
  deps: TurnExitDeps,
  input: AgentLoopInput,
  state: TurnRuntimeState,
): AsyncGenerator<AgentEvent, TurnStepReturn, unknown> {
  const createTurnResult = makeTurnResultBuilder(deps);
  const result = createTurnResult(input, {
    type: "aborted",
    stopReason: "aborted_streaming",
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    turns: state.turnCount,
    startedAt: state.startedAt,
    finalMessage: state.finalMessage,
  });
  const status = createAbortStatus(input);
  if (status) {
    yield await emitStatus(input, status);
  }
  await captureTurn(deps, input, state, result.type === "error");
  yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
  return { kind: "return", result, messages: state.messages };
}
