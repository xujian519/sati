/**
 * 编辑/重新生成最后一条用户消息（遮蔽式 append-only，协议 1.7）。
 *
 * 不修改历史转录行：校验通过后追加一条 turn_rewrite 控制条目，声明
 * 「最后一个 accepted_input + 同 turn 的消息条目」的投影被遮蔽；重放与
 * Web 投影据此跳过这些条目。新输入由调用方（gateway 接线层）随后走标准
 * submit_turn 写入新 accepted_input——投影自然派生「遮蔽后的历史 + 新输入」。
 *
 * 前置校验（全部 fail-explicit，不重试不猜测）：
 * - 无进行中 turn（调用方经 SessionRouter 预检）
 * - 无挂起审批（调用方经 GatewayApprovalBus 预检）
 * - 存在最后一条 accepted_input，其 turn 已完整收尾（有 turn_result）
 * - 该 accepted_input 位于最后 compact_boundary 之后（历史已被摘要替代的
 *   尾巴不可编辑）
 * - 输入为纯文本（附件/非文本块不支持）
 */
import { randomUUID } from "node:crypto";
import { appendFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CanonicalContentBlock } from "../../model/index.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentTurnRewriteTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import { findLastCompactBoundaryIndex } from "../../session/transcript/TranscriptReplay.js";

export type RewriteLastTurnReason =
  | "no_last_turn"
  | "active_turn"
  | "pending_approval"
  | "unsupported_content"
  | "compact_tail";

export type RewriteLastTurnInput = {
  sessionKey: string;
  reason: "edit_last_turn" | "regenerate_last_turn";
  /** edit 的新文本（regenerate 忽略）。 */
  newText?: string;
};

export type RewriteLastTurnOptions = {
  projectRoot: string;
  pilotHome: string;
  now?: () => Date;
};

export type RewriteLastTurnResult = {
  rewritten: boolean;
  reason?: RewriteLastTurnReason;
  /** 被遮蔽条目数（rewritten=true 时）。 */
  shadowedEntryCount?: number;
  /** 原用户文本（regenerate 的调用方据此重发）。 */
  originalText?: string;
  turnId?: string;
};

type LastTurnTarget = {
  acceptedInput: AgentAcceptedInputTranscriptEntry;
  /** 被遮蔽条目：accepted_input 自身 + 同 turn 的 assistant/tool_result/durable 消息。 */
  shadowFromEntryIds: string[];
  originalText: string;
};

const MESSAGE_ENTRY_TYPES = new Set(["assistant_message", "tool_result_message", "durable_message"]);

// 同会话并发 rewrite（跨标签页同时编辑/重新生成同一 idle 会话）用 per-session
// 互斥把 read → findLastTurnTarget → appendFile 整段串行化：若让两个请求各自
// 独立读快照再追加，会写到重复 sequence / 过时 parentEntryId 的 turn_rewrite，
// 破坏 append-only 排序不变式。锁在任务完成后移除，避免长驻 server 无界累积。
const rewriteLocks = new Map<string, Promise<unknown>>();

async function withSessionRewriteLock<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
  const previous = rewriteLocks.get(sessionKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  rewriteLocks.set(sessionKey, next);
  try {
    return await next;
  } finally {
    if (rewriteLocks.get(sessionKey) === next) {
      rewriteLocks.delete(sessionKey);
    }
  }
}

function extractAcceptedInputText(entry: AgentAcceptedInputTranscriptEntry): string {
  const chunks: string[] = [];
  for (const message of entry.messages) {
    for (const block of message.content as CanonicalContentBlock[]) {
      if (block.type === "text" && block.text.trim()) {
        chunks.push(block.text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function hasNonTextContent(entry: AgentAcceptedInputTranscriptEntry): boolean {
  return entry.messages.some(message =>
    (message.content as CanonicalContentBlock[]).some(block => block.type !== "text"),
  );
}

/**
 * 定位最后一条可编辑 turn：最后一个 accepted_input + 其后同 turn 的消息条目。
 * 返回 null 表示无可用目标（空会话）；targetCheck 失败原因由调用方区分。
 */
function findLastTurnTarget(
  entries: AgentTranscriptEntry[],
): LastTurnTarget | null | { reason: RewriteLastTurnReason } {
  let accepted: AgentAcceptedInputTranscriptEntry | undefined;
  let lastAcceptedIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "accepted_input") {
      accepted = entry;
      lastAcceptedIndex = index;
      break;
    }
  }
  if (!accepted) {
    return { reason: "no_last_turn" };
  }
  // 旧转录可能无 entryId（hand-written / 早期版本）：遮蔽集按 entryId 定位，
  // 无 id 则无法精确遮蔽，保守拒绝。
  if (accepted.entryId === undefined) {
    return { reason: "no_last_turn" };
  }
  // 最后输入在压缩边界之前：其消息已被摘要替代，重放投影本就不含它，
  // 编辑 + 重发会让历史里同时存在摘要与新输入，语义错位。
  if (findLastCompactBoundaryIndex(entries) > lastAcceptedIndex) {
    return { reason: "compact_tail" };
  }
  // turn 必须已完整收尾：未完成的 turn（崩溃残片等）不编辑，留给 resume 扫描器。
  const turnComplete = entries.some(entry => entry.type === "turn_result" && entry.turnId === accepted.turnId);
  if (!turnComplete) {
    return { reason: "no_last_turn" };
  }
  if (hasNonTextContent(accepted)) {
    return { reason: "unsupported_content" };
  }
  const originalText = extractAcceptedInputText(accepted);
  if (!originalText) {
    return { reason: "no_last_turn" };
  }
  const shadowFromEntryIds: string[] = [accepted.entryId];
  for (const entry of entries) {
    if (entry.turnId === accepted.turnId && MESSAGE_ENTRY_TYPES.has(entry.type) && entry.entryId !== undefined) {
      shadowFromEntryIds.push(entry.entryId);
    }
  }
  return { acceptedInput: accepted, shadowFromEntryIds, originalText };
}

export async function rewriteLastTurn(
  input: RewriteLastTurnInput,
  options: RewriteLastTurnOptions,
): Promise<RewriteLastTurnResult> {
  return withSessionRewriteLock(input.sessionKey, () => rewriteLastTurnLocked(input, options));
}

async function rewriteLastTurnLocked(
  input: RewriteLastTurnInput,
  options: RewriteLastTurnOptions,
): Promise<RewriteLastTurnResult> {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const transcriptPath = resolve(chatDir, `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`);

  const { entries } = await readTranscript(transcriptPath);
  if (entries.length === 0) {
    return { rewritten: false, reason: "no_last_turn" };
  }

  const target = findLastTurnTarget(entries);
  if (target === null || "reason" in target) {
    return { rewritten: false, reason: target === null ? "no_last_turn" : target.reason };
  }

  const now = options.now ?? (() => new Date());
  const lastEntry = entries[entries.length - 1]!;
  const maxSequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const entry: AgentTurnRewriteTranscriptEntry = {
    type: "turn_rewrite",
    sessionId: input.sessionKey,
    turnId: target.acceptedInput.turnId,
    sequence: maxSequence + 1,
    createdAt: now().toISOString(),
    entryId: randomUUID(),
    parentEntryId: lastEntry.entryId ?? null,
    rewrite: {
      shadowFromEntryIds: target.shadowFromEntryIds,
      reason: input.reason,
      ...(input.reason === "edit_last_turn" && input.newText !== undefined ? { newText: input.newText } : {}),
    },
  };

  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(dirname(transcriptPath), 0o700);

  return {
    rewritten: true,
    shadowedEntryCount: target.shadowFromEntryIds.length,
    originalText: target.originalText,
    turnId: target.acceptedInput.turnId,
  };
}
