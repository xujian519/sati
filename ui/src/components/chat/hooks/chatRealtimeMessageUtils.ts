import { logWarn } from "../../../utils/logging";
import { asRecord } from "../../../utils/unknown";
import type { PendingPermissionRequest } from "../types/types";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import type { LatestChatMessage } from "./chatRealtimeTypes";

function normalizeAssistantStreamText(value?: string): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function getMessageRunId(message: LatestChatMessage | NormalizedMessage): string | undefined {
  const runId = asRecord(message)?.runId;
  return typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
}

/** 桥帧（LatestChatMessage）→ store 模型；桥已归一化字段形状（sati-bridge.js），帧为宽视图、store 为窄视图（5 个必需字段），按 store 契约消费。 */
export function toNormalizedMessage(msg: LatestChatMessage): NormalizedMessage {
  return msg as LatestChatMessage & NormalizedMessage;
}

/**
 * 桥帧 `origin` → 待审批条目（形状校验后再入 state）：缺 `subagentId` 的帧
 * 按「无归属」处理，避免把畸形帧渲染成「来自子代理 undefined」。
 */
export function parseRequestOrigin(value: unknown): PendingPermissionRequest["origin"] {
  const record = asRecord(value);
  if (!record) return undefined;
  const subagentId = typeof record.subagentId === "string" ? record.subagentId.trim() : "";
  if (!subagentId) return undefined;
  const subagentType = typeof record.subagentType === "string" ? record.subagentType.trim() : "";
  return {
    kind: typeof record.kind === "string" && record.kind ? record.kind : "subagent",
    subagentId,
    ...(subagentType ? { subagentType } : {}),
  };
}

function parseAssistantStreamTimestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCompatibleAssistantStreamRun(incoming: NormalizedMessage, existing: NormalizedMessage): boolean {
  if (incoming.runId != null && existing.runId != null) return incoming.runId === existing.runId;
  const isActiveStream = existing.kind === "stream_delta" && String(existing.id || "").startsWith("__streaming_");
  if (!isActiveStream) return false;
  const incomingTimestamp = parseAssistantStreamTimestamp(incoming.timestamp);
  const existingTimestamp = parseAssistantStreamTimestamp(existing.timestamp);
  if (incomingTimestamp == null || existingTimestamp == null) return false;
  return Math.abs(incomingTimestamp - existingTimestamp) <= 10_000;
}

export function getDuplicateAssistantStreamTextState(
  incoming: NormalizedMessage,
  realtimeMessages: NormalizedMessage[],
): { isDuplicate: boolean; hasActiveStream: boolean; activeStreamRunId?: string | null } {
  if (incoming.kind !== "text" || incoming.role !== "assistant") {
    return { isDuplicate: false, hasActiveStream: false };
  }

  const incomingText = normalizeAssistantStreamText(incoming.content);
  if (!incomingText) {
    return { isDuplicate: false, hasActiveStream: false };
  }

  let hasActiveStream = false;
  let activeStreamRunId: string | null | undefined;
  const isDuplicate = realtimeMessages.some(message => {
    const isAssistantText = message.kind === "text" && message.role === "assistant";
    const isActiveStream = message.kind === "stream_delta" && String(message.id || "").startsWith("__streaming_");
    if (!isAssistantText && !isActiveStream) return false;
    if (isAssistantText && (incoming.runId == null || message.runId == null)) return false;
    if (!isCompatibleAssistantStreamRun(incoming, message)) return false;
    if (normalizeAssistantStreamText(message.content) !== incomingText) return false;
    if (isActiveStream) {
      hasActiveStream = true;
      activeStreamRunId = message.runId ?? null;
    }
    return true;
  });

  return { isDuplicate, hasActiveStream, activeStreamRunId };
}

type ActiveTurnReplayState = {
  realtimeMessages?: NormalizedMessage[];
  serverMessages?: NormalizedMessage[];
};

type VolatileReplayBlock = {
  kind: "stream_delta" | "thinking";
  messages: LatestChatMessage[];
  text: string;
  runId?: string;
};

function isRenderedVolatileBlockCandidate(block: VolatileReplayBlock, message: NormalizedMessage): boolean {
  const blockText = normalizeAssistantStreamText(block.text);
  if (!blockText) return false;

  const messageRunId = getMessageRunId(message);
  if (block.runId && messageRunId && block.runId !== messageRunId) {
    return false;
  }

  if (block.kind === "stream_delta") {
    const isAssistantText = message.kind === "text" && message.role === "assistant";
    const isActiveStream = message.kind === "stream_delta" && String(message.id || "").startsWith("__streaming_");
    if (!isAssistantText && !isActiveStream) return false;
  } else if (message.kind !== "thinking") {
    return false;
  }

  return normalizeAssistantStreamText(message.content) === blockText;
}

function hasRenderedVolatileReplayBlock(block: VolatileReplayBlock, state: ActiveTurnReplayState): boolean {
  const messages = [...(state.realtimeMessages || []), ...(state.serverMessages || [])];
  return messages.some(message => isRenderedVolatileBlockCandidate(block, message));
}

export function getActiveTurnReplayMessagesToApply(
  activeTurnMessages: LatestChatMessage[],
  state: ActiveTurnReplayState = {},
  options: { skipVolatile?: boolean } = {},
): LatestChatMessage[] {
  if (!Array.isArray(activeTurnMessages) || activeTurnMessages.length === 0) {
    return [];
  }

  const output: LatestChatMessage[] = [];
  let block: VolatileReplayBlock | null = null;

  const flushBlock = () => {
    if (!block) return;
    if (!options.skipVolatile && !hasRenderedVolatileReplayBlock(block, state)) {
      output.push(...block.messages);
    }
    block = null;
  };

  for (const message of activeTurnMessages) {
    const kind = String(message?.kind || "");
    if (kind === "thinking" || kind === "stream_delta") {
      if (block && block.kind !== kind) {
        flushBlock();
      }
      if (!block) {
        block = {
          kind: kind as "thinking" | "stream_delta",
          messages: [],
          text: "",
          runId: getMessageRunId(message),
        };
      }
      block.messages.push(message);
      block.text += typeof message.content === "string" ? message.content : "";
      block.runId ??= getMessageRunId(message);
      continue;
    }

    if (kind === "stream_end") {
      if (block?.kind === "stream_delta") {
        block.messages.push(message);
        block.runId ??= getMessageRunId(message);
        flushBlock();
      }
      continue;
    }

    flushBlock();
    output.push(message);
  }

  flushBlock();
  return output;
}

export function getExplicitSessionId(msg: {
  sessionId?: unknown;
  session_id?: unknown;
  actualSessionId?: unknown;
  newSessionId?: unknown;
}): string | null {
  const value = msg.sessionId ?? msg.session_id ?? msg.actualSessionId ?? msg.newSessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

export function resolveSessionId(msg: LatestChatMessage, fallbackSessionId?: string | null): string | null {
  const explicit = getExplicitSessionId(msg);
  if (explicit) return explicit;
  if (typeof fallbackSessionId === "string" && fallbackSessionId.trim()) {
    return fallbackSessionId.trim();
  }
  return null;
}

export function warnDroppedFrame(msg: LatestChatMessage): void {
  logWarn("[chat] Dropped WS frame without sessionId", {
    kind: msg.kind,
    type: msg.type,
  });
}

export function warnResolvedSessionId(msg: LatestChatMessage, fallbackSessionId: string): void {
  logWarn("[chat] Resolved missing sessionId from parent context", {
    kind: msg.kind,
    type: msg.type,
    fallbackSessionId,
  });
}
