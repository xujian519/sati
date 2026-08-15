/**
 * 孤儿 turn 合成（阶段四 T4.3）。
 *
 * 崩溃/强制退出会在 transcript 留下「有活动（消息/请求头）但无 turn_result」
 * 的孤儿 turn。resume 时合成 turn_result{interrupted} 收尾，保证括号平衡：
 * 重放投影不再报「incomplete turn」诊断，UI/审计可见显式的 interrupted 状态。
 * 只处理最后一个开放 turn（历史孤儿 turn 已由上次 resume 收尾）。
 */
import { randomUUID } from "node:crypto";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { agentError } from "../../agent/protocol/errors.js";
import type {
  AgentTranscriptEntry,
  AgentTranscriptEntryType,
  AgentTurnResultTranscriptEntry,
} from "./TranscriptEntry.js";

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
    if (ACTIVITY_ENTRY_TYPES.has(entry.type) && entry.turnId !== openTurnId) {
      openTurnId = entry.turnId;
      openStartedAt = entry.createdAt;
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
 * 扫描条目；若最后一个 turn 未收尾，把合成结果交给 writer 落盘，并返回等价的
 * turn_result 条目供调用方并入本次回放的条目序列——使「本次 resume 的投影」
 * 立即反映合成收尾（否则要等下一次 resume 读取到落盘条目后才闭合，期间
 * 重放会报 incomplete turn 诊断并丢弃该 turn 的 durable 消息）。
 *
 * @param entries - transcript 条目序列。
 * @param recordTurnResult - 落盘回调（resume 时是 storage.transcript.recordTurnResult）。
 * @param sessionId - 会话 id。
 * @param options.nextSequence - 合成条目的 sequence（resume 时 = 上次 maxSeq + 1，
 *   与 writer 经 restoreState 后首写的自增结果一致）。
 * @param options.parentEntryId - 合成条目的 parentEntryId（resume 时 = 上次最后
 *   条目的 entryId，与 writer 的 lastEntryId 一致）。
 * @param options.now - 收尾时间（缺省当前时间）。
 * @returns 合成条目的 turn_result（可直接 push 进 entries 供重放投影）；无开放
 *   turn 时返回 undefined。
 */
export function synthesizeInterruptedTurn(
  entries: readonly AgentTranscriptEntry[],
  recordTurnResult: (result: AgentTurnResult) => void | Promise<void>,
  sessionId: string,
  options: {
    nextSequence: number;
    parentEntryId?: string | null;
    now?: () => Date;
  },
): AgentTurnResultTranscriptEntry | undefined {
  const open = findOpenTurn(entries);
  if (open === undefined) {
    return undefined;
  }
  const result = buildInterruptedTurnResult(sessionId, open.turnId, open.startedAt, options.now);
  void recordTurnResult(result);
  return {
    type: "turn_result",
    sessionId,
    turnId: open.turnId,
    sequence: options.nextSequence,
    createdAt: result.completedAt,
    entryId: randomUUID(),
    parentEntryId: options.parentEntryId ?? null,
    result,
  };
}

/**
 * 请求级开放请求（跨进程重启续算 T-B）：识别「request_header 已落、响应未到」
 * 的断点请求，构成 step 粒度续算点。
 *
 * 形态（见计划 §2.0 前提 4 / §2.2）：
 *   - `a`：request_header 之后同 turn 无任何 durable 消息——请求完全未响应，可续算；
 *   - `b`：request_header 之后同 turn 已有部分 durable 消息（流式残片）——
 *     append-only 无法删除残片，首期不自动续算（沿用 interrupted 收尾 + 人工重发）。
 *
 * 只返回最后一个开放请求；turn 已闭合（该 turn 出现 turn_result）则返回 undefined。
 */
export type OpenRequest = {
  turnId: string;
  provider: string;
  model: string;
  /** 断点请求条目的 sequence（与 writer 的 sequence 一致，供审计对齐）。 */
  sequence: number;
  form: "a" | "b";
};

export function findOpenRequest(entries: readonly AgentTranscriptEntry[]): OpenRequest | undefined {
  let candidate: OpenRequest | undefined;
  for (const entry of entries) {
    if (entry.type === "turn_result") {
      if (candidate !== undefined && entry.turnId === candidate.turnId) {
        candidate = undefined;
      }
      continue;
    }
    if (entry.type === "request_header") {
      candidate = {
        turnId: entry.turnId,
        provider: entry.header.provider,
        model: entry.header.model,
        sequence: entry.sequence,
        form: "a",
      };
      continue;
    }
    if (
      entry.type === "assistant_message" ||
      entry.type === "tool_result_message" ||
      entry.type === "durable_message"
    ) {
      if (candidate !== undefined && entry.turnId === candidate.turnId) {
        candidate = { ...candidate, form: "b" };
      }
    }
  }
  return candidate;
}
