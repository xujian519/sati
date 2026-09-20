import { type MutableRefObject, useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../types/types";
import type { NormalizedMessage, SessionStore } from "../../../stores/useSessionStore";
import type { SessionProvider } from "../../../types/app";
import { parseUserAttachmentNote } from "../utils/attachmentNotes";
import { normalizedToChatMessages } from "./useChatMessages";

/**
 * 消息视图层 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 把「store 里的消息 → 渲染消息」这一段收在一起：
 *
 * - `chatMessages`：`normalizedToChatMessages` + 乐观气泡门控（只在该气泡被提交进的会话里渲染）
 *   + `viewHiddenCount` 截断（回退若干条）；
 * - `activityMessages`：活动流的投影（流式 tick 高频 render 下靠引用稳定命中 memo，P3-1）；
 * - `addMessage` / `clearMessages` / `rewindMessages`：写 realtime 槽、清 realtime 槽、回退条数；
 * - 与它配套的纯函数（`chatMessageToNormalized` / `hasEquivalentUserMessage` / 判重辅助）一并搬来，
 *   主文件按原路径 re-export（既有测试导入不变）。
 *
 * ⚠️ 调用点在主 hook 里**必须**在「乐观气泡 flush」之后、分页 hook 之前：
 * flush 会往 store 里 append realtime 消息，本 hook 紧接着读同一个 store；次序反了会让
 * 刚 flush 的气泡晚一帧才出现。而分页 hook 需要本 hook 产出的 `chatMessages`。
 *
 * 单一真源：store 句柄、`pendingUserMessage`、会话身份都由调用方持有，本 hook 不复制。
 */

/** 空数组常量：保持引用稳定，使 `activityMessages` 的 memo 依赖不随渲染变化。 */
const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];

/**
 * Whether the optimistic "pending user message" bubble should render in the
 * currently active view. The pending bubble is hook-wide singleton state on
 * `ChatInterfaceV2`; without this gate, switching sessions while it's queued
 * would prepend the optimistic text onto the WRONG session's transcript —
 * surfaced as "the latest query I just typed appears at the top of an
 * unrelated session I just opened".
 *
 * It belongs here iff:
 *   1. We are still on the welcome surface (no active session yet) — the
 *      pending bubble is the only thing the user can see.
 *   2. The active session id matches the session id `pendingViewSessionRef`
 *      was bound to at submit time (stamped by `session_created`).
 */
export function shouldRenderPendingBubble(
  activeSessionId: string | null,
  pendingTargetSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  return pendingTargetSessionId !== null && pendingTargetSessionId === activeSessionId;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

export function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: SessionProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts =
    msg.timestamp instanceof Date
      ? msg.timestamp.toISOString()
      : typeof msg.timestamp === "number"
        ? new Date(msg.timestamp).toISOString()
        : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: "tool_use",
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: "thinking", content: msg.content || "" } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: "interactive_prompt", content: msg.content || "" } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: "task_notification",
      status: msg.taskStatus || "completed",
      summary: msg.content || "",
    } as NormalizedMessage;
  }
  if (msg.type === "error") {
    return {
      ...base,
      kind: "error",
      content: msg.content || "",
      ...(typeof msg.userHint === "string" ? { userHint: msg.userHint } : {}),
    } as NormalizedMessage;
  }
  // Carry user-attached image data URLs through the normalize round-trip
  // so the optimistic message render and any re-derivation from the
  // session store both show the thumbnails. NormalizedMessage.images is
  // `string[]` of data URLs; we only attach it on user-side text frames.
  const images =
    msg.type === "user" && Array.isArray(msg.images)
      ? msg.images.filter(img => img && typeof img.data === "string").map(img => img.data)
      : undefined;
  const attachments =
    msg.type === "user" && Array.isArray(msg.attachments)
      ? msg.attachments.filter(attachment => attachment && typeof attachment.name === "string")
      : undefined;
  return {
    ...base,
    kind: "text",
    role: msg.type === "user" ? "user" : "assistant",
    content: msg.content || "",
    ...(images && images.length > 0 ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  } as NormalizedMessage;
}

function normalizeUserMessageText(value: unknown): string {
  const parsed = parseUserAttachmentNote(value);
  return parsed.content.replace(/\s+/g, " ").trim();
}

function getUserAttachmentNames(message: ChatMessage): string[] {
  const explicitNames = Array.isArray(message.attachments)
    ? message.attachments.map(attachment => attachment.name || "").filter(Boolean)
    : [];
  const parsedNames = parseUserAttachmentNote(message.content)
    .attachments.map(attachment => attachment.name || "")
    .filter(Boolean);
  return [...explicitNames, ...parsedNames].sort();
}

export function hasEquivalentUserMessage(messages: ChatMessage[], pendingUserMessage: ChatMessage): boolean {
  const pendingText = normalizeUserMessageText(pendingUserMessage.content);
  const pendingImageCount = Array.isArray(pendingUserMessage.images) ? pendingUserMessage.images.length : 0;
  const pendingAttachmentNames = getUserAttachmentNames(pendingUserMessage);
  // 同一文本连发两次时，文本 + 图片数 + 附件名可能完全一致（例如重复问同一句），
  // 只按内容比较会把第二次的乐观气泡吞掉。两侧都带 turnId/runId 时以它为身份
  // （同一 turn 才是同一条消息），否则退回内容比较。
  const pendingTurnId = pendingUserMessage.turnId || pendingUserMessage.runId;

  return messages.some(message => {
    if (message.type !== "user") return false;
    const messageTurnId = message.turnId || message.runId;
    if (pendingTurnId || messageTurnId) {
      return Boolean(pendingTurnId && messageTurnId && pendingTurnId === messageTurnId);
    }
    if (normalizeUserMessageText(message.content) !== pendingText) return false;

    const imageCount = Array.isArray(message.images) ? message.images.length : 0;
    if (imageCount !== pendingImageCount) return false;

    const attachmentNames = getUserAttachmentNames(message);
    return attachmentNames.join("\n") === pendingAttachmentNames.join("\n");
  });
}

export interface UseChatTranscriptViewArgs {
  sessionStore: SessionStore;
  activeSessionId: string | null;
  pendingUserMessage: ChatMessage | null;
  setPendingUserMessage: (message: ChatMessage | null) => void;
  pendingViewSessionRef: MutableRefObject<{ sessionId: string | null; startedAt: number } | null>;
}

export function useChatTranscriptView({
  sessionStore,
  activeSessionId,
  pendingUserMessage,
  setPendingUserMessage,
  pendingViewSessionRef,
}: UseChatTranscriptViewArgs) {
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : EMPTY_NORMALIZED_MESSAGES;
  // 空分支用模块级常量（与 storeMessages 同款模式）：保持引用稳定，使下方
  // activityMessages useMemo 依赖不随渲染变化（exhaustive-deps），同时保留
  // 「slot.activityMessages 引用替换 → 重算」的引用级失效语义。
  const activityStoreMessages = activeSessionId
    ? (sessionStore.getActivityMessages?.(activeSessionId) ?? EMPTY_NORMALIZED_MESSAGES)
    : EMPTY_NORMALIZED_MESSAGES;
  const subagentLinks = activeSessionId ? sessionStore.getSessionSlot?.(activeSessionId)?.subagentLinks : undefined;

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  // `pendingViewSessionRef.current.sessionId` is the session the optimistic
  // bubble was actually queued for. session_created stamps it. We read it
  // here AND list it as a memo dep (via `pendingTargetSessionId`) so the
  // memo recomputes when session_created upgrades the ref from null → real id.
  const pendingTargetSessionId = pendingViewSessionRef.current?.sessionId ?? null;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages, subagentLinks);
    // The optimistic user bubble must ONLY render in the session it was
    // submitted into. Two valid surfaces:
    //   1. The welcome surface itself (activeSessionId=null), while we are
    //      still waiting for `session_created` to tell us the real id.
    //   2. The exact session id that `pendingViewSessionRef` was bound to
    //      at submit time.
    // Without this gate, a sidebar click after a welcome submit (or any
    // session switch while the bubble is queued) would prepend the
    // optimistic text onto the WRONG session's transcript — surfaced as
    // "the latest query I just typed appears at the top of an unrelated
    // session I just opened". The caller's handoff block eventually pushes
    // the bubble into the right store + clears it, but React's discard-
    // and-rerender on render-phase setState isn't a guarantee under
    // concurrent rendering / batched parent updates, so we also defend
    // here at the read site.
    const pendingBelongsHere = shouldRenderPendingBubble(activeSessionId, pendingTargetSessionId);
    if (pendingUserMessage && pendingBelongsHere && !hasEquivalentUserMessage(all, pendingUserMessage)) {
      return [pendingUserMessage, ...all];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage, activeSessionId, pendingTargetSessionId, subagentLinks]);

  // 流式 tick 高频 render：activityStoreMessages 引用在 store 未更新时稳定
  // （slot.activityMessages 只在 upsertActivity/setActivities 时替换），
  // useMemo 命中跳过每 tick 的 normalizedToChatMessages 全量转换（P3-1）。
  const activityMessages = useMemo(() => normalizedToChatMessages(activityStoreMessages), [activityStoreMessages]);

  const addMessage = useCallback(
    (msg: ChatMessage, targetSessionId?: string | null) => {
      const sessionId = targetSessionId !== undefined ? targetSessionId : activeSessionId;
      if (!sessionId) {
        // No session yet — show as pending until the backend creates one
        setPendingUserMessage(msg);
        return;
      }
      const normalized = chatMessageToNormalized(msg, sessionId, "sati");
      if (normalized) {
        sessionStore.appendRealtime(sessionId, normalized);
      }
    },
    [activeSessionId, sessionStore, setPendingUserMessage],
  );

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  return {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    setViewHiddenCount,
  };
}
