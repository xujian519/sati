/**
 * Web 历史消息注入（从 readSessionMessages.ts 拆出）。
 *
 * 在 CanonicalMessage 投影基础上，把压缩边界、file_artifacts、错误 turn、
 * agent 状态等「语义消息」按时间位置插入 allMessages。投影主流程仍由
 * readSessionMessages.ts 负责。
 */

import type { CanonicalMessage } from "../../model/index.js";
import { createLogger } from "../../telemetry/index.js";
import { replayShadowedMessagesAt } from "../../session/transcript/TranscriptReplay.js";
import { isCompactBoundaryEntry, type AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { WebMessage } from "../client/webMessage.js";
import { flattenCanonicalMessage } from "./webMessageFlatten.js";

const logger = createLogger("readSessionMessages");

export type CompactBoundaryInfo = {
  insertAfterMessageIndex: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
  /** entries 中该 compact_boundary 的索引（供按边界恢复被遮蔽原文）。 */
  boundaryIndex: number;
};

/**
 * 把各次压缩的 compact_boundary WebMessage 按插入位置（insertAfterMessageIndex
 * 之后）写入 flattenedPerMessage（与 CanonicalMessage 投影一一对应，插入后再
 * flat，保证分页/顺序正确）。payload 内嵌该次压缩被遮蔽的原文（WebMessage 级）。
 */
export function insertCompactBoundaryMessages(
  input: { sessionKey: string; projectKey?: string },
  flattenedPerMessage: WebMessage[][],
  boundaries: CompactBoundaryInfo[],
  entries: AgentTranscriptEntry[],
  options: { now?: () => Date },
): void {
  // 连续压缩（两次边界之间无新消息）时 insertAfterMessageIndex 相同，若都
  // splice 到同一位置，后处理的边界会被插到先处理的前面（时间顺序颠倒）。
  // 记录每个位置的已插入数，同位置的后续边界顺延到其后。
  const insertedAtPosition = new Map<number, number>();
  for (const boundary of boundaries) {
    const shadowed = replayShadowedMessagesAt(entries, boundary.boundaryIndex);
    if (shadowed.diagnostics.length > 0) {
      logger.warn(`压缩边界 ${boundary.boundaryIndex} 被遮蔽历史还原对齐告警：`, shadowed.diagnostics);
    }
    const shadowedMessages: WebMessage[] = [];
    for (let index = 0; index < shadowed.messages.length; index += 1) {
      const message = shadowed.messages[index]!;
      shadowedMessages.push(
        ...flattenCanonicalMessage(message, {
          index,
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          now: options.now,
          entryTimestamp: boundary.timestamp,
        }),
      );
    }
    const compactionId =
      boundary.metadata && typeof boundary.metadata.compactionId === "string"
        ? boundary.metadata.compactionId
        : undefined;
    const baseInsertAt = boundary.insertAfterMessageIndex + 1;
    const offset = insertedAtPosition.get(baseInsertAt) ?? 0;
    const insertAt = Math.min(baseInsertAt + offset, flattenedPerMessage.length);
    insertedAtPosition.set(baseInsertAt, offset + 1);
    flattenedPerMessage.splice(insertAt, 0, [
      {
        id: `${input.sessionKey}-compact-${compactionId ?? boundary.boundaryIndex}`,
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        createdAt: boundary.timestamp,
        provider: "sati",
        role: "system",
        kind: "compact_boundary",
        payload: {
          ...(boundary.metadata ?? {}),
          shadowedMessages,
          ...(shadowed.diagnostics.length > 0 ? { shadowedDiagnostics: shadowed.diagnostics } : {}),
        },
        source: "history",
      },
    ]);
  }
}

/** 从 control_boundary 条目提取压缩边界元数据（供 WebMessage payload 透传）。 */
export function compactBoundaryMetadata(
  entry: AgentTranscriptEntry & { type: "control_boundary" },
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (isCompactBoundaryEntry(entry)) {
    const cm = entry.boundary.compactMetadata;
    if (typeof cm.compactionId === "string" && cm.compactionId.length > 0) {
      meta.compactionId = cm.compactionId;
    }
    meta.trigger = cm.trigger;
    meta.preTokens = cm.preTokens;
    meta.postTokens = cm.postTokens;
    meta.messagesSummarized = cm.messagesSummarized;
    if (Array.isArray(cm.shadowedRanges)) {
      meta.shadowedRanges = cm.shadowedRanges;
    }
  }
  return meta;
}

/**
 * 把按 createdAt 升序收集的新消息插入到 allMessages 的对应时间位置。
 * 单调游标：allMessages 与 newMessages 均按 createdAt 升序（transcript 是
 * 追加日志，写入时间单调），双指针线性归并——替代旧的「每条倒序全扫找
 * 插入点」（O(N×M) 扫描，长会话每条注入都从尾部扫一遍）。等值（createdAt
 * 相同）时新消息插在等值旧消息之后，与旧行为一致。
 */
function injectMessagesSortedByTimestamp(allMessages: WebMessage[], newMessages: WebMessage[]): void {
  let cursor = 0;
  for (const message of newMessages) {
    while (cursor < allMessages.length && allMessages[cursor]!.createdAt <= message.createdAt) {
      cursor += 1;
    }
    allMessages.splice(cursor, 0, message);
    cursor += 1; // 越过刚插入的自身（后续消息只可能插在其后）
  }
}

export function injectFileArtifactMessages(
  entries: AgentTranscriptEntry[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const artifactMessages: WebMessage[] = [];
  const turnsWithToolResults = new Set(
    entries
      .filter(
        entry =>
          (entry.type === "assistant_message" ||
            entry.type === "tool_result_message" ||
            entry.type === "durable_message") &&
          messageContainsToolResult(entry.message),
      )
      .map(entry => entry.turnId),
  );
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== "file_artifacts" || entry.artifacts.length === 0) continue;
    const artifacts = turnsWithToolResults.has(entry.turnId)
      ? entry.artifacts
      : entry.artifacts.filter(artifact => artifact.source !== "workspace_diff");
    if (artifacts.length === 0) continue;
    artifactMessages.push({
      id: entry.entryId ?? `${sessionKey}-file-artifacts-${entry.turnId}-${entry.sequence}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "sati",
      role: "assistant",
      kind: "file_artifacts",
      artifacts,
      payload: { turnId: entry.turnId },
      source: "history",
      ...(entry.entryId ? { entryId: entry.entryId } : {}),
    });
  }

  injectMessagesSortedByTimestamp(allMessages, artifactMessages);
}

function messageContainsToolResult(message: CanonicalMessage): boolean {
  return message.content.some(block => block.type === "tool_result" || block.type === "tool_result_reference");
}

/**
 * Scan transcript entries for failed turns (`turn_result` with `type === "error"`)
 * and inject corresponding `WebMessage { kind: 'error' }` into the message list
 * so error banners survive history reload when no visible semantic status
 * already represents the same turn.
 */
export function injectErrorTurnMessages(
  entries: AgentTranscriptEntry[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const visibleFailureStatusTurnIds = new Set(
    entries
      .filter(
        entry => entry.type === "agent_status_message" && entry.kind === "error" && entry.detail?.visible !== false,
      )
      .map(entry => entry.turnId),
  );
  const errorMessages: WebMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "turn_result" || entry.result.type !== "error") continue;
    if (visibleFailureStatusTurnIds.has(entry.turnId)) continue;
    const errorTexts = entry.result.errors?.map(e => e.message).filter(Boolean) ?? [];
    const text = errorTexts.length > 0 ? errorTexts.join("\n") : `Turn failed: ${entry.result.stopReason}`;
    errorMessages.push({
      id: `${sessionKey}-turn-error-${entry.turnId}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "sati",
      role: "error",
      kind: "error",
      text,
      payload: { code: entry.result.stopReason, recoverable: false },
      source: "history",
    });
  }
  if (errorMessages.length === 0) return;

  injectMessagesSortedByTimestamp(allMessages, errorMessages);
}

export function injectAgentStatusMessages(
  entries: AgentTranscriptEntry[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const statusMessages: WebMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "agent_status_message") continue;
    statusMessages.push({
      id: entry.entryId ?? `${sessionKey}-agent-status-${entry.turnId}-${entry.sequence}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "sati",
      role: entry.kind === "error" ? "error" : "system",
      kind: entry.kind,
      text: entry.text,
      ...(isI18nDescriptor(entry.detail?.messageI18n) ? { contentI18n: entry.detail.messageI18n } : {}),
      ...(isI18nDescriptor(entry.detail?.userHintI18n) ? { userHintI18n: entry.detail.userHintI18n } : {}),
      payload: { event: entry.event, ...(entry.detail ? { detail: entry.detail } : {}) },
      source: "history",
    });
  }
  if (statusMessages.length === 0) return;

  injectMessagesSortedByTimestamp(allMessages, statusMessages);
}

function isI18nDescriptor(value: unknown): value is { key: string; params?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && typeof (value as { key?: unknown }).key === "string";
}
