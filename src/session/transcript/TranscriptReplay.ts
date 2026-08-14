import { cloneMessage, cloneMessages, type CanonicalMessage, type CanonicalUsage } from "../../model/index.js";
import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../../agent/protocol/result.js";
import type { InjectionRecord } from "../../context/protocol/types.js";
import {
  isCompactBoundaryEntry,
  type AgentTranscriptDiagnostic,
  type AgentTranscriptEntry,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";

export type AgentTranscriptReplayResult = {
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  events: AgentEvent[];
  metadata: SessionMetadataValue;
  diagnostics: AgentTranscriptDiagnostic[];
  /**
   * Index of the last compact_boundary entry consumed during replay. When
   * present, only messages after this entry are kept in `messages`.
   */
  lastCompactBoundaryIndex?: number;
  /** Last compact boundary entry encountered (for resume relink). */
  lastCompactBoundary?: AgentTranscriptEntry & { type: "control_boundary" };
};

/**
 * Find the index of the last compact boundary entry. Used by resume / replay
 * to slice messages after the boundary.
 */
export function findLastCompactBoundaryIndex(entries: AgentTranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundaryEntry(entries[index]!)) {
      return index;
    }
  }
  return -1;
}

/**
 * 提交输入的历史消息投影（运行期 messages 投影化的读取面）：transcript 是
 * 唯一真源，返回「最后一次压缩边界之后的模型可见消息」（压缩产物 + 之后
 * 新增的 durable 消息）——与 run() 内存视图一致。供 AgentSession 在每次
 * submit 时用持久层派生历史消息，消除内存态与持久态漂移。
 */
export function projectMessagesFromTranscript(entries: AgentTranscriptEntry[]): CanonicalMessage[] {
  return replayTranscriptEntries(entries).messages;
}

export function replayTranscriptEntries(entries: AgentTranscriptEntry[]): AgentTranscriptReplayResult {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  const messages: CanonicalMessage[] = [];
  const events: AgentEvent[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  let metadata: SessionMetadataValue = {};
  let usage: CanonicalUsage = {};
  let permissionDenials: AgentPermissionDenial[] = [];
  let lastCompactBoundary: (AgentTranscriptEntry & { type: "control_boundary" }) | undefined;

  const completedTurnIds = new Set(entries.filter(entry => entry.type === "turn_result").map(entry => entry.turnId));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // Past compact boundary: usage / metadata still merge; messages produced
    // before the boundary are dropped (legacy getMessagesAfterCompactBoundary).
    const beforeBoundary = lastBoundaryIndex !== -1 && index < lastBoundaryIndex;

    switch (entry.type) {
      case "accepted_input":
        if (!beforeBoundary) {
          messages.push(...cloneMessages(entry.messages));
          events.push({
            type: "input_accepted",
            sessionId: entry.sessionId,
            turnId: entry.turnId,
            messages: cloneMessages(entry.messages),
          });
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (!completedTurnIds.has(entry.turnId)) {
          diagnostics.push({
            code: "transcript_entry_invalid",
            severity: "warning",
            message: `Skipping durable message for incomplete turn ${entry.turnId}.`,
          });
          break;
        }
        if (beforeBoundary) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        events.push(projectMessageEvent(entry.sessionId, entry.turnId, entry.message));
        break;
      case "turn_result":
        usage = mergeUsage(usage, entry.result.usage);
        permissionDenials = [...permissionDenials, ...entry.result.permissionDenials];
        if (!beforeBoundary) {
          events.push({
            type: "turn_completed",
            sessionId: entry.sessionId,
            turnId: entry.turnId,
            result: cloneTurnResult(entry.result),
          });
        }
        break;
      case "control_boundary":
        if (isCompactBoundaryEntry(entry)) {
          lastCompactBoundary = entry;
        }
        break;
      case "session_metadata":
        metadata = mergeMetadata(metadata, entry.metadata);
        break;
      case "agent_status_message":
      case "file_artifacts":
        break;
      case "subagent_started":
      case "subagent_completed":
        // C3: lazy-load. The parent transcript replay does NOT expand
        // sidechain content; consumers wanting subagent details call
        // `replaySubagentTranscript(...)` explicitly.
        break;
      case "injected_context":
        // 注入内容参考条目（记忆/指令/方法论）：仅供审计/回放查询，
        // 不进入模型可见 messages 投影。
        break;
    }
  }

  return {
    messages,
    usage,
    permissionDenials,
    events,
    metadata,
    diagnostics,
    lastCompactBoundaryIndex: lastBoundaryIndex === -1 ? undefined : lastBoundaryIndex,
    lastCompactBoundary,
  };
}

/**
 * 投影给定消息条目序列（accepted_input 展开 + assistant/tool_result/durable
 * 消息）——replayShadowedMessages 的序列基础。
 *
 * 与 replayTranscriptEntries 的消息构造不同：本函数不做「turn 必须已完成」
 * 过滤。遮蔽重建是纯展示用途，压缩发生时已落库的消息就应纳入还原序列——
 * turn 完成状态与「压缩输入当时的 messages」无关；过滤会引入索引错位（mid-turn
 * 压缩场景下活动 turn 的消息已被压缩遮蔽，却因 turn 未完成被丢弃）。
 */
function projectFullMessageSequence(entries: AgentTranscriptEntry[]): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "accepted_input") {
      messages.push(...cloneMessages(entry.messages));
      continue;
    }
    if (
      entry.type === "assistant_message" ||
      entry.type === "tool_result_message" ||
      entry.type === "durable_message"
    ) {
      messages.push(cloneMessage(entry.message));
    }
  }
  return messages;
}

export type ShadowedMessagesResult = {
  /** 被遮蔽（压缩前）的原文消息，按投影序列顺序（仅匹配 shadowedRanges 的段）。 */
  messages: CanonicalMessage[];
  /** 命中的投影序列索引（升序）。 */
  matchedIndexes: number[];
  /** 对齐自检诊断：还原数少于 shadowedRanges 期望数时提示（非空即异常）。 */
  diagnostics: AgentTranscriptDiagnostic[];
};

/**
 * 从 transcript 恢复最后一次压缩被遮蔽（摘要替代）的原文消息。
 *
 * 对应 dsh 的 surface replace 语义：压缩不删历史，只遮蔽——transcript
 * 中的 durable_message 原文完整保留，本函数按最后一个 compact_boundary
 * 记录的 shadowedRanges（压缩输入 messages 索引）从投影序列提取被替换的
 * 原文，供审计 / UI 历史回看 / 恢复。
 *
 * 多压缩场景下恢复指定边界的原文请用 `replayShadowedMessagesAt`。
 */
export function replayShadowedMessages(entries: AgentTranscriptEntry[]): ShadowedMessagesResult {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  if (lastBoundaryIndex === -1) {
    return { messages: [], matchedIndexes: [], diagnostics: [] };
  }
  return replayShadowedMessagesAt(entries, lastBoundaryIndex);
}

/**
 * 从 transcript 恢复第 `boundaryIndex` 个 compact_boundary 被遮蔽的原文。
 *
 * 与 `replayShadowedMessages` 相同的索引对齐语义，但边界位置由调用方指定
 * （entries 中 control_boundary 的索引），支持 UI 对每次压缩分别展开历史。
 *
 * 索引对齐基础：该次压缩的输入序列 = 上次压缩产物（boundary/摘要/保留消息，
 * 经 onCompactPersisted 落库为 durable_message）+ 其间新增消息，即
 * 「前一个 compact_boundary 之后、本 boundary 之前」的落库消息。残余错位
 * 仅来自未落库消息（transient synthetic prompts、压缩产物持久化失败被吞），
 * 由 diagnostics 中的对齐自检提示而非静默截断。
 */
export function replayShadowedMessagesAt(
  entries: AgentTranscriptEntry[],
  boundaryIndex: number,
): ShadowedMessagesResult {
  const boundary = entries[boundaryIndex];
  if (boundary === undefined || !isCompactBoundaryEntry(boundary)) {
    return { messages: [], matchedIndexes: [], diagnostics: [] };
  }
  const ranges = boundary.boundary.compactMetadata.shadowedRanges;
  if (!ranges || ranges.length === 0) {
    return { messages: [], matchedIndexes: [], diagnostics: [] };
  }
  // 投影基础：该次压缩输入区间（上次压缩产物 + 其间新增消息）。
  let previousBoundaryIndex = -1;
  for (let index = boundaryIndex - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate !== undefined && isCompactBoundaryEntry(candidate)) {
      previousBoundaryIndex = index;
      break;
    }
  }
  const sequence = projectFullMessageSequence(entries.slice(previousBoundaryIndex + 1, boundaryIndex));
  const matchedIndexes: number[] = [];
  const messages: CanonicalMessage[] = [];
  let expectedCount = 0;
  for (const range of ranges) {
    expectedCount += range.toIndex - range.fromIndex + 1;
    for (let i = range.fromIndex; i <= range.toIndex && i < sequence.length; i += 1) {
      matchedIndexes.push(i);
      messages.push(sequence[i]!);
    }
  }
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  if (messages.length !== expectedCount) {
    diagnostics.push({
      code: "shadowed_message_alignment",
      severity: "warning",
      message:
        `shadowedRanges 期望 ${expectedCount} 条被遮蔽消息，实际还原 ${messages.length} 条` +
        `（投影序列 ${sequence.length} 条）。未落库消息（transient/持久化失败）会导致索引错位。`,
    });
  }
  return { messages, matchedIndexes, diagnostics };
}

function projectMessageEvent(sessionId: string, turnId: string, message: CanonicalMessage): AgentEvent {
  if (message.role === "assistant") {
    return { type: "assistant_message", sessionId, turnId, message: cloneMessage(message) };
  }
  return { type: "tool_results_projected", sessionId, turnId, message: cloneMessage(message) };
}

export type InjectedContextRecord = InjectionRecord & {
  turnId: string;
};

/**
 * 读取 transcript 中的注入内容参考条目（「模型可见 = 已记录」的审计面）。
 * 可选按 turnId/source 过滤。返回按 transcript 顺序排列。
 */
export function readInjectedContexts(
  entries: AgentTranscriptEntry[],
  filter?: { turnId?: string; source?: string },
): InjectedContextRecord[] {
  const out: InjectedContextRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "injected_context") continue;
    if (filter?.turnId !== undefined && entry.turnId !== filter.turnId) continue;
    if (filter?.source !== undefined && entry.source !== filter.source) continue;
    out.push({
      turnId: entry.turnId,
      source: entry.source,
      text: entry.text,
      ...(entry.partIndex !== undefined ? { partIndex: entry.partIndex } : {}),
    });
  }
  return out;
}

function cloneTurnResult(result: AgentTurnResult): AgentTurnResult {
  return {
    ...result,
    usage: { ...result.usage },
    permissionDenials: result.permissionDenials.map(denial => ({ ...denial })),
    errors: result.errors?.map(error => ({ ...error })),
  };
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

function mergeMetadata(first: SessionMetadataValue, second: SessionMetadataValue): SessionMetadataValue {
  return {
    ...first,
    ...second,
    title: second.title ?? first.title,
    linkedPullRequest: second.linkedPullRequest ?? first.linkedPullRequest,
  };
}
