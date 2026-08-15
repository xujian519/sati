/**
 * 孤儿 turn 合成（阶段四 T4.3）。
 *
 * 崩溃/强制退出会在 transcript 留下「有活动（消息/请求头）但无 turn_result」
 * 的孤儿 turn。resume 时合成 turn_result{interrupted} 收尾，保证括号平衡：
 * 重放投影不再报「incomplete turn」诊断，UI/审计可见显式的 interrupted 状态。
 * 只处理最后一个开放 turn（历史孤儿 turn 已由上次 resume 收尾）。
 */
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { agentError } from "../../agent/protocol/errors.js";
import type { AgentTranscriptEntry, AgentTranscriptEntryType } from "./TranscriptEntry.js";

/** 携带 turn 活动、可判定「turn 已开始」的条目类型。 */
const ACTIVITY_ENTRY_TYPES: ReadonlySet<AgentTranscriptEntryType> = new Set([
  "accepted_input",
  "assistant_message",
  "tool_result_message",
  "durable_message",
  "request_header",
  "injected_context",
]);

/**
 * 找出最后一个有活动但未收尾（无 turn_result）的 turn。
 *
 * @param entries - transcript 条目序列。
 * @returns 开放 turn 的 turnId；无则 undefined。
 */
export function findOpenTurn(
  entries: readonly AgentTranscriptEntry[],
): { turnId: string; startedAt: string } | undefined {
  let openTurnId: string | undefined;
  let openStartedAt: string | undefined;
  for (const entry of entries) {
    if (entry.type === "turn_result") {
      if (entry.turnId === openTurnId) {
        openTurnId = undefined;
        openStartedAt = undefined;
      }
      continue;
    }
    if (ACTIVITY_ENTRY_TYPES.has(entry.type)) {
      if (entry.turnId !== openTurnId) {
        openTurnId = entry.turnId;
        openStartedAt = entry.createdAt;
      }
    }
  }
  return openTurnId === undefined || openStartedAt === undefined
    ? undefined
    : { turnId: openTurnId, startedAt: openStartedAt };
}

/**
 * 构建一个 interrupted 收尾的 turn_result。
 *
 * @param sessionId - 会话 id。
 * @param turnId - 开放 turn id。
 * @param startedAt - 开放 turn 的首条活动时间（用于审计时间线）。
 * @param now - 收尾时间；缺省当前时间。
 * @returns 可直接经 recordTurnResult 写入的 turn 结果。
 */
export function buildInterruptedTurnResult(
  sessionId: string,
  turnId: string,
  startedAt: string,
  now: () => Date = () => new Date(),
): AgentTurnResult {
  return {
    type: "error",
    sessionId,
    turnId,
    stopReason: "interrupted",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt,
    completedAt: now().toISOString(),
    errors: [
      agentError(
        "agent_turn_interrupted",
        "Turn was left open by an interrupted run (crash or forced exit); marked interrupted on resume.",
      ),
    ],
  };
}

/**
 * 扫描条目；若最后一个 turn 未收尾，把合成结果交给 writer 落盘。
 *
 * @param entries - transcript 条目序列。
 * @param recordTurnResult - 落盘回调（resume 时是 storage.transcript.recordTurnResult）。
 * @param sessionId - 会话 id。
 * @param startedAt - 开放 turn 的首条活动时间。
 * @returns 是否合成了收尾条目。
 */
export function synthesizeInterruptedTurn(
  entries: readonly AgentTranscriptEntry[],
  recordTurnResult: (result: AgentTurnResult) => void | Promise<void>,
  sessionId: string,
  startedAt: string,
): boolean {
  const open = findOpenTurn(entries);
  if (open === undefined) {
    return false;
  }
  void recordTurnResult(buildInterruptedTurnResult(sessionId, open.turnId, startedAt));
  return true;
}
