import { textFromMessage, type CanonicalMessage, type CanonicalToolCall } from "../../model/index.js";
import type { SatiToolResult } from "../../tool/index.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";
import { type DoomLoop, type DoomLoopSignal, type ToolCallObservation } from "./doomLoop.js";

export type DoomLoopObservation = {
  signals: DoomLoopSignal[];
  turn: number;
};

/**
 * Doom-loop integration layer for AgentLoop: observation (record model/tool
 * activity into the detector), signal emission (`doomloop_signal` events) and
 * the combined `record*` helpers the loop calls in one step.
 *
 * Extracted from AgentLoop so doom-loop behavior can be unit-tested and
 * evolved independently of the loop state machine. The loop owns the
 * fatal-reason state (it terminates the turn on it), so the combined helpers
 * *return* the fatal reason instead of reading this module's state.
 */

/** 单个 DoomLoop 信号 → `doomloop_signal` 事件（纯映射，可单测）。 */
export function doomLoopSignalEvent(signal: DoomLoopSignal, context: DoomLoopEmitContext, turn: number): AgentEvent {
  return {
    type: "doomloop_signal",
    sessionId: context.sessionId,
    turnId: context.turnId,
    detector: signal.detector,
    reason: signal.reason,
    turn,
    fatal: signal.fatal,
  };
}

export type DoomLoopEmitContext = {
  sessionId: string;
  turnId: string;
};

/**
 * Emit doom-loop signals as `doomloop_signal` events and return the last fatal
 * reason seen (undefined when no fatal signal fired).
 */
export function emitDoomLoopSignals(
  signals: DoomLoopSignal[],
  context: DoomLoopEmitContext,
  turn: number,
  eventEmitter?: AgentEventEmitter,
): string | undefined {
  let fatal: string | undefined;
  for (const signal of signals) {
    eventEmitter?.(doomLoopSignalEvent(signal, context, turn));
    if (signal.fatal) fatal = signal.reason;
  }
  return fatal;
}

/**
 * Record a model-call observation into the DoomLoop detector and return the
 * resulting signals (empty array when none fired). Returns undefined when no
 * DoomLoop is configured (fatal doom-loop detection is off by default).
 */
export function observeModelCall(
  doomLoop: DoomLoop | undefined,
  message: CanonicalMessage,
): DoomLoopObservation | undefined {
  if (!doomLoop) return undefined;
  return {
    signals: doomLoop.recordModelCall({ text: textFromMessage(message) }),
    turn: doomLoop.currentTurnNumber(),
  };
}

/**
 * Record tool-result observations for every call/result pair and return the
 * aggregated signals. Returns undefined when no DoomLoop is configured.
 */
export function observeToolResults(
  doomLoop: DoomLoop | undefined,
  toolCalls: CanonicalToolCall[],
  results: SatiToolResult[],
): DoomLoopObservation | undefined {
  if (!doomLoop) return undefined;
  const turn = doomLoop.currentTurnNumber();
  const signals: DoomLoopSignal[] = [];
  for (let i = 0; i < toolCalls.length; i += 1) {
    const call = toolCalls[i]!;
    const result = results[i];
    const observation: ToolCallObservation = {
      name: call.name,
      args: call.input,
      result: result ? flattenToolResultText(result) : "",
    };
    signals.push(...doomLoop.recordToolResult(observation));
  }
  return { signals, turn };
}

/**
 * Combined observe + emit for a model call: one call from the loop that
 * records into the detector, emits any signals, and returns the fatal reason
 * (undefined when no DoomLoop is configured or nothing fatal fired).
 */
export function recordModelCall(
  doomLoop: DoomLoop | undefined,
  message: CanonicalMessage,
  context: DoomLoopEmitContext,
  eventEmitter?: AgentEventEmitter,
): string | undefined {
  const observed = observeModelCall(doomLoop, message);
  if (!observed) return undefined;
  return emitDoomLoopSignals(observed.signals, context, observed.turn, eventEmitter);
}

/**
 * Combined observe + emit for tool results. Returns the fatal reason
 * (undefined when no DoomLoop is configured or nothing fatal fired).
 */
export function recordToolResults(
  doomLoop: DoomLoop | undefined,
  toolCalls: CanonicalToolCall[],
  results: SatiToolResult[],
  context: DoomLoopEmitContext,
  eventEmitter?: AgentEventEmitter,
): string | undefined {
  const observed = observeToolResults(doomLoop, toolCalls, results);
  if (!observed) return undefined;
  return emitDoomLoopSignals(observed.signals, context, observed.turn, eventEmitter);
}

/** 工具结果文本（供 DoomLoop 空结果/重复检测）。 */
function flattenToolResultText(result: SatiToolResult): string {
  return result.content
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.value);
      return "";
    })
    .join("\n")
    .trim();
}
