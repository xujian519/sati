import type { SessionProvider } from "../../types/app";
import {
  forceRecomputeMerged,
  INVISIBLE_REALTIME_KINDS,
  MAX_REALTIME_MESSAGES,
  patchMergedStreamingMessage,
  recomputeMergedIfNeeded,
  streamingKey,
  upsertRealtimeMessages,
  type NormalizedMessage,
} from "../sessionStoreCore";
import type { SessionActionContext } from "./context";

export function createStreamActions(ctx: SessionActionContext) {
  const { getSlot, notify, storeRef } = ctx;

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = (sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    let updated = upsertRealtimeMessages(slot.realtimeMessages, [msg]);
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    if (!INVISIBLE_REALTIME_KINDS.has(msg.kind)) {
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  };

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = (sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    let updated = upsertRealtimeMessages(slot.realtimeMessages, msgs);
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  };

  // Shared body for updateStreaming/Thinking — identical except for the
  // streaming-id prefix and the message kind.
  const updateStreamSlot = (
    sessionId: string,
    accumulatedText: string,
    msgProvider: SessionProvider,
    runId: string | undefined,
    streamIdPrefix: string,
    kind: "stream_delta" | "thinking",
  ) => {
    const slot = getSlot(sessionId);
    const streamId = `${streamIdPrefix}${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      // Subsequent delta — preserve the original turn-start timestamp so
      // computeMerged can tell which server snapshots belong to this turn.
      const existing = slot.realtimeMessages[idx];
      if (existing.content === accumulatedText && existing.provider === msgProvider) {
        return;
      }
      // Patch merged BEFORE mutating existing so patchMergedStreamingMessage
      // still sees the old content when it decides to copy the row.
      if (!patchMergedStreamingMessage(slot, streamId, accumulatedText, msgProvider)) {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
        forceRecomputeMerged(slot);
      } else {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
      }
      notify(sessionId);
      return;
    }
    // Record the id of server's tail message at the moment this turn
    // started streaming. computeMerged uses this for an id-based
    // dedup check that's immune to NTP drift / burst-turn time
    // windows: only delete the server tail if it's a NEW message
    // (a real mid-stream snapshot) rather than the previous turn's
    // legitimate trailing assistant message.
    const serverTailId = slot.serverMessages.length > 0 ? slot.serverMessages[slot.serverMessages.length - 1].id : null;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind,
      content: accumulatedText,
      runId,
      serverTailIdAtStart: serverTailId ?? undefined,
    };
    slot.realtimeMessages = [...slot.realtimeMessages, msg];
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  };

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = (
    sessionId: string,
    accumulatedText: string,
    msgProvider: SessionProvider,
    runId?: string,
  ) => {
    updateStreamSlot(sessionId, accumulatedText, msgProvider, runId, "__streaming_", "stream_delta");
  };

  // Shared body for finalizeStreaming/Thinking — identical except for the
  // streaming-id prefix, the new-id prefix, and the finalized row fields.
  const finalizeStreamSlot = (
    sessionId: string,
    runId: string | undefined,
    streamIdPrefix: string,
    newIdPrefix: string,
    finalFields: Partial<Pick<NormalizedMessage, "kind" | "role">>,
  ) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `${streamIdPrefix}${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      const newId = `${newIdPrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: newId,
        ...finalFields,
        isFinal: true,
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  };

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = (sessionId: string, runId?: string) => {
    finalizeStreamSlot(sessionId, runId, "__streaming_", "text_", { kind: "text", role: "assistant" });
  };

  /**
   * Update or create a streaming thinking message (accumulated thinking so far).
   * Mirrors updateStreaming but uses kind='thinking' and a separate well-known ID.
   */
  const updateStreamingThinking = (
    sessionId: string,
    accumulatedText: string,
    msgProvider: SessionProvider,
    runId?: string,
  ) => {
    updateStreamSlot(sessionId, accumulatedText, msgProvider, runId, "__streaming_thinking_", "thinking");
  };

  /**
   * Finalize streaming thinking: replace the well-known streaming thinking ID
   * with a unique ID so subsequent thinking blocks don't overwrite it.
   */
  const finalizeStreamingThinking = (sessionId: string, runId?: string) => {
    finalizeStreamSlot(sessionId, runId, "__streaming_thinking_", "thinking_", {});
  };

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = (sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  };

  const clearAssistantRealtime = (sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const nextRealtime = slot.realtimeMessages.filter(message => {
      if (message.kind === "thinking" || message.kind === "stream_delta" || message.kind === "stream_end") {
        return false;
      }
      return !(message.kind === "text" && message.role === "assistant");
    });
    if (nextRealtime.length === slot.realtimeMessages.length) return;
    slot.realtimeMessages = nextRealtime;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  };

  return {
    appendRealtime,
    appendRealtimeBatch,
    updateStreaming,
    finalizeStreaming,
    updateStreamingThinking,
    finalizeStreamingThinking,
    clearRealtime,
    clearAssistantRealtime,
  };
}
