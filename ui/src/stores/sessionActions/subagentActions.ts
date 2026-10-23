import type { SessionProvider } from "../../types/app";
import { getFinalizedSubagentThinkingId, upsertRealtimeMessages, type NormalizedMessage } from "../sessionStoreCore";
import type { SessionActionContext } from "./context";

export function createSubagentActions(ctx: SessionActionContext) {
  const { getSlot, notify, storeRef } = ctx;

  const recordSubagentLink = (sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const { toolCallId, subagentId, subagentType } = msg;
    if (toolCallId && subagentId) {
      const nextLinks = new Map(slot.subagentLinks);
      nextLinks.set(toolCallId, { subagentId, subagentType: subagentType || "agent" });
      slot.subagentLinks = nextLinks;
      notify(sessionId);
    }
  };

  const appendSubagentDetailMessage = (sessionId: string, subagentId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    let msgToStore = msg;
    if ((msg.kind === "tool_use" || msg.kind === "tool_result") && msg.toolId) {
      const existing = current.find(m => m.kind === msg.kind && m.toolId === msg.toolId && m.id === msg.id);
      if (!existing || existing.toolName !== msg.toolName) {
        msgToStore = { ...msg, id: `${msg.id}::${msg.kind}::${msg.toolId}::${current.length}` };
      } else {
        msgToStore = { ...msg, id: existing.id };
      }
    }
    const updated = upsertRealtimeMessages(current, [msgToStore]);
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  };

  // Shared body for updateSubagentDetailStreaming/Thinking — identical except
  // for the streaming-id prefix and the message kind.
  const updateSubagentDetailStreamSlot = (
    sessionId: string,
    subagentId: string,
    delta: string,
    msgProvider: SessionProvider,
    streamIdPrefix: string,
    kind: "stream_delta" | "thinking",
  ) => {
    if (!delta) return;
    const slot = getSlot(sessionId);
    const streamId = `${streamIdPrefix}${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex(message => message.id === streamId);
    let updated: NormalizedMessage[];
    if (existingIndex >= 0) {
      updated = [...current];
      const existing = updated[existingIndex];
      updated[existingIndex] = {
        ...existing,
        content: `${existing.content || ""}${delta}`,
        provider: msgProvider,
      };
    } else {
      updated = [
        ...current,
        {
          id: streamId,
          sessionId,
          timestamp: new Date().toISOString(),
          provider: msgProvider,
          kind,
          role: "assistant",
          content: delta,
          subagentId,
          isSubagentDetail: true,
        },
      ];
    }
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  };

  const updateSubagentDetailStreaming = (
    sessionId: string,
    subagentId: string,
    delta: string,
    msgProvider: SessionProvider,
  ) => {
    updateSubagentDetailStreamSlot(sessionId, subagentId, delta, msgProvider, "__subagent_streaming_", "stream_delta");
  };

  const updateSubagentDetailThinking = (
    sessionId: string,
    subagentId: string,
    delta: string,
    msgProvider: SessionProvider,
  ) => {
    updateSubagentDetailStreamSlot(sessionId, subagentId, delta, msgProvider, "__subagent_thinking_", "thinking");
  };

  // Shared body for finalizeSubagentDetailStreaming/Thinking — identical except
  // for the streaming-id prefix and the finalized row shape.
  const finalizeSubagentDetailStreamSlot = (
    sessionId: string,
    subagentId: string,
    streamIdPrefix: string,
    toFinal: (stream: NormalizedMessage) => NormalizedMessage,
  ) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `${streamIdPrefix}${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex(message => message.id === streamId);
    if (existingIndex < 0) return;
    const stream = current[existingIndex];
    const updated = [...current];
    updated[existingIndex] = toFinal(stream);
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  };

  const finalizeSubagentDetailStreaming = (sessionId: string, subagentId: string) => {
    finalizeSubagentDetailStreamSlot(sessionId, subagentId, "__subagent_streaming_", stream => ({
      ...stream,
      id: `subagent_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "text",
      role: "assistant",
    }));
  };

  const finalizeSubagentDetailThinking = (sessionId: string, subagentId: string) => {
    finalizeSubagentDetailStreamSlot(sessionId, subagentId, "__subagent_thinking_", stream => ({
      ...stream,
      id: getFinalizedSubagentThinkingId(sessionId, subagentId, stream.timestamp),
    }));
  };

  const getSubagentDetailMessages = (sessionId: string, subagentId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.subagentDetailMessages.get(subagentId) ?? [];
  };

  return {
    recordSubagentLink,
    appendSubagentDetailMessage,
    updateSubagentDetailStreaming,
    finalizeSubagentDetailStreaming,
    updateSubagentDetailThinking,
    finalizeSubagentDetailThinking,
    getSubagentDetailMessages,
  };
}
