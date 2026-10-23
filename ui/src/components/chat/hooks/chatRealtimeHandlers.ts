import {
  getDuplicateAssistantStreamTextState,
  getExplicitSessionId,
  resolveSessionId,
  toNormalizedMessage,
  warnDroppedFrame,
  warnResolvedSessionId,
} from "./chatRealtimeMessageUtils";
import { createLegacyMessageHandler } from "./chatRealtimeLegacyHandlers";
import { createChatRealtimeSideEffects } from "./chatRealtimeSideEffects";
import type {
  ChatRealtimeFrame,
  ChatRealtimeHandlerDeps,
  ChatRealtimeMessageHandler,
  LatestChatMessage,
} from "./chatRealtimeTypes";

type KindHandlerEntry = {
  matches: (msg: LatestChatMessage) => boolean;
  handle: (frame: ChatRealtimeFrame) => void;
};

export function createChatRealtimeMessageHandler(deps: ChatRealtimeHandlerDeps): ChatRealtimeMessageHandler {
  const { provider, selectedSession, currentSessionId, pendingViewSessionRef, sessionStore, thinkingBySessionRef } =
    deps;

  const runSideEffect = createChatRealtimeSideEffects(deps);
  const handleLegacyMessage = createLegacyMessageHandler({ deps, handleMessage });

  const handleAgentActivity = ({ msg, sid }: ChatRealtimeFrame) => {
    const activitySubagentId =
      typeof msg.subagentId === "string"
        ? msg.subagentId
        : String(msg.activityId || "").startsWith("subagent:")
          ? String(msg.activityId).slice("subagent:".length)
          : "";
    if (
      activitySubagentId &&
      msg.phase === "subagent" &&
      ["completed", "failed", "cancelled"].includes(String(msg.state || ""))
    ) {
      sessionStore.finalizeSubagentDetailThinking?.(sid, activitySubagentId);
      sessionStore.finalizeSubagentDetailStreaming?.(sid, activitySubagentId);
    }
    sessionStore.upsertActivity?.(sid, toNormalizedMessage(msg));
    return;
  };

  const handleSubagentLink = ({ msg, sid }: ChatRealtimeFrame) => {
    sessionStore.recordSubagentLink?.(sid, toNormalizedMessage(msg));
    return;
  };

  const handleProjection = ({ msg, sid, msgRunId, streamKey }: ChatRealtimeFrame) => {
    // --- Absolute projection (gateway-side epoch projection, 协议 1.9) ---
    // 帧内容是「本段正文到目前为止的全文」。它只用于把当前流式行**推进**成全文：
    // 追加（`updateStreaming` 的常规用法）会与已经收到的 delta 叠加成重复文本，
    // 而无条件覆盖又会回退掉本帧之后才到达的 delta。
    const projectedText = typeof msg.content === "string" ? msg.content : "";
    if (!projectedText) return;
    // 正文出现意味着思考已结束（与 stream_delta 分支同语义）。
    if (thinkingBySessionRef.current.has(sid)) {
      thinkingBySessionRef.current.delete(sid);
      sessionStore.finalizeStreamingThinking(sid, msgRunId);
    }
    const streamId = `__streaming_${streamKey}`;
    const existing = sessionStore.getSessionSlot?.(sid)?.realtimeMessages.find(message => message.id === streamId);
    const currentText = typeof existing?.content === "string" ? existing.content : "";
    // 行内容是本段的**片段**（开局被截断、断线期间缺中间段）→ 覆盖成全文；
    // 行内容不在其中（本帧之后又到了新 delta，行比投影新）→ 丢弃本帧等下次轮询。
    if (existing && currentText.length > 0 && !projectedText.includes(currentText)) return;
    sessionStore.updateStreaming?.(sid, projectedText, provider, msgRunId);
    return;
  };

  const handleSubagentDetail = ({ msg, sid }: ChatRealtimeFrame) => {
    const subagentId = typeof msg.subagentId === "string" ? msg.subagentId : "";
    if (msg.isSubagentDetail && subagentId) {
      if (msg.kind === "thinking") {
        sessionStore.updateSubagentDetailThinking?.(sid, subagentId, msg.content || "", provider);
        return;
      }
      if (msg.kind === "stream_delta") {
        sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
        sessionStore.updateSubagentDetailStreaming?.(sid, subagentId, msg.content || "", provider);
        return;
      }
      if (msg.kind === "stream_end") {
        sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
        sessionStore.finalizeSubagentDetailStreaming?.(sid, subagentId);
        return;
      }
      sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
      sessionStore.finalizeSubagentDetailStreaming?.(sid, subagentId);
      sessionStore.appendSubagentDetailMessage?.(sid, subagentId, toNormalizedMessage(msg));
      return;
    }
  };

  const handleStreamDelta = ({ msg, sid, msgRunId, streamKey }: ChatRealtimeFrame) => {
    // --- Streaming: direct accumulation (no smoother animation) ---
    const text = msg.content || "";
    if (!text) return;
    // Content starting means thinking is done
    if (thinkingBySessionRef.current.has(sid)) {
      thinkingBySessionRef.current.delete(sid);
      sessionStore.finalizeStreamingThinking(sid, msgRunId);
    }
    const slot = sessionStore.getSessionSlot?.(sid);
    const streamId = `__streaming_${streamKey}`;
    const existing = slot?.realtimeMessages.find(m => m.id === streamId);
    const currentText = existing?.content || "";
    sessionStore.updateStreaming(sid, currentText + text, provider, msgRunId);
    return;
  };

  const handleThinking = ({ msg, sid, msgRunId, streamKey }: ChatRealtimeFrame) => {
    // --- Thinking: direct accumulation (same as content) ---
    const text = msg.content || "";
    if (!text) return;
    // Mark that thinking is active
    thinkingBySessionRef.current.set(sid, true);
    // Read current thinking content and append delta
    const slot = sessionStore.getSessionSlot?.(sid);
    const streamId = `__streaming_thinking_${streamKey}`;
    const existing = slot?.realtimeMessages.find(m => m.id === streamId);
    const currentText = existing?.content || "";
    sessionStore.updateStreamingThinking(sid, currentText + text, provider, msgRunId);
    return;
  };

  const handleStreamEnd = ({ sid, msgRunId }: ChatRealtimeFrame) => {
    // --- Stream end: finalize content stream ---
    // Finalize thinking if still active
    if (thinkingBySessionRef.current.has(sid)) {
      thinkingBySessionRef.current.delete(sid);
      sessionStore.finalizeStreamingThinking(sid, msgRunId);
    }
    sessionStore.finalizeStreaming(sid, msgRunId);
    return;
  };

  const kindHandlers: KindHandlerEntry[] = [
    { matches: msg => msg.kind === "agent_activity", handle: handleAgentActivity },
    { matches: msg => msg.kind === "subagent_link", handle: handleSubagentLink },
    { matches: msg => msg.kind === "text" && msg.activeTurnProjection === true, handle: handleProjection },
    {
      matches: msg => Boolean(msg.isSubagentDetail) && typeof msg.subagentId === "string" && msg.subagentId.length > 0,
      handle: handleSubagentDetail,
    },
    { matches: msg => msg.kind === "stream_delta", handle: handleStreamDelta },
    { matches: msg => msg.kind === "thinking", handle: handleThinking },
    { matches: msg => msg.kind === "stream_end", handle: handleStreamEnd },
  ];

  function handleMessage(latestMessage: LatestChatMessage, fallbackSessionId?: string | null): void {
    if (!latestMessage) return;

    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeCurrentSessionId = pendingSessionId === currentSessionId ? currentSessionId : null;
    const activeViewSessionId = selectedSession?.id || activeCurrentSessionId || pendingSessionId || null;

    const msg = latestMessage;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field)                                */
    /* ---------------------------------------------------------------- */

    if (!msg.kind) {
      handleLegacyMessage(msg, activeViewSessionId);
      return;
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = resolveSessionId(msg, fallbackSessionId);
    if (!sid) {
      warnDroppedFrame(msg);
      return;
    }
    const msgRunId = typeof msg.runId === "string" && msg.runId.trim() ? msg.runId.trim() : undefined;
    const streamKey = msgRunId ? `${sid}_${msgRunId}` : sid;

    if (!getExplicitSessionId(msg) && fallbackSessionId) {
      warnResolvedSessionId(msg, sid);
    }

    const isForActiveView = sid === activeViewSessionId;

    // Ensure the store's activeSession matches so notify() triggers re-renders.
    // Without this, the RAF scheduler silently drops notifications for
    // sessions it doesn't consider "active", causing content to not render
    // until some other state change (like clicking stop) triggers a re-render.
    if (isForActiveView) {
      sessionStore.setActiveSession(sid);
    }

    if (msg.kind === "text" && msg.role === "user") {
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
      }
    }

    const frame: ChatRealtimeFrame = { msg, sid, msgRunId, streamKey, isForActiveView };
    const kindHandler = kindHandlers.find(handler => handler.matches(msg));
    if (kindHandler) {
      kindHandler.handle(frame);
      return;
    }

    // Only route certain message kinds to the store append logic.
    const flushKinds = new Set(["tool_use", "tool_result", "text", "complete", "error", "permission_request"]);
    if (flushKinds.has(msg.kind as string)) {
      // Finalize thinking if still active (model moved past thinking)
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
      // Finalize content stream on tool_use / complete / error.
      // The gateway may not send stream_end, so tool_use is the
      // reliable signal that the text block has ended.
      if (msg.kind === "tool_use" || msg.kind === "complete" || msg.kind === "error") {
        sessionStore.finalizeStreaming(sid, msgRunId);
      }
      if (msg.kind === "complete" || msg.kind === "error") {
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
    }

    // --- All other messages: route to store ---
    // Skip assistant text messages that duplicate finalized streaming content.
    // The streaming pipeline (stream_delta → stream_end → finalizeStreaming)
    // already creates a text message in realtimeMessages. If the backend also
    // sends a standalone 'text' message with the same content, skip it.
    const duplicateStreamTextState = getDuplicateAssistantStreamTextState(
      toNormalizedMessage(msg),
      sessionStore.getSessionSlot?.(sid)?.realtimeMessages ?? [],
    );
    if (duplicateStreamTextState.hasActiveStream) {
      sessionStore.finalizeStreaming(sid, duplicateStreamTextState.activeStreamRunId ?? undefined);
    }
    if (!duplicateStreamTextState.isDuplicate) {
      sessionStore.appendRealtime(sid, toNormalizedMessage(msg));
    }

    // --- UI side effects for specific kinds ---
    runSideEffect(msg.kind as string, frame);
  }

  return handleMessage;
}
