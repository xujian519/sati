import { describe, expect, it } from "vitest";
import {
  clearDisconnectedQueue,
  enqueueDisconnectedMessage,
  getQueuedMessageKey,
  isQueueableDisconnectedMessage,
  type WsMessage,
} from "./WebSocketContext";

describe("WebSocket disconnected send queue", () => {
  it("does not queue sati commands without an idempotency key", () => {
    const queue: WsMessage[] = [];

    enqueueDisconnectedMessage(queue, { type: "sati-command", text: "one" });
    enqueueDisconnectedMessage(queue, { type: "sati-command", text: "two" });

    expect(getQueuedMessageKey({ type: "sati-command", text: "one" })).toBeNull();
    expect(isQueueableDisconnectedMessage({ type: "sati-command", text: "one" })).toBe(false);
    expect(queue).toEqual([]);
  });

  it("dedupes check-session-status by sessionId and keeps the latest message", () => {
    const queue: WsMessage[] = [];

    enqueueDisconnectedMessage(queue, {
      type: "check-session-status",
      sessionId: "session-1",
      includeActiveTurnMessages: false,
    });
    enqueueDisconnectedMessage(queue, {
      type: "check-session-status",
      sessionId: "session-1",
      includeActiveTurnMessages: true,
    });

    expect(queue).toEqual([
      {
        type: "check-session-status",
        sessionId: "session-1",
        includeActiveTurnMessages: true,
      },
    ]);
  });

  it("does not make unsafe control messages queueable", () => {
    expect(getQueuedMessageKey({ type: "abort-session", sessionId: "session-1" })).toBeNull();
    expect(getQueuedMessageKey({ type: "permission-response", sessionId: "session-1" })).toBeNull();
    expect(getQueuedMessageKey({ type: "watch-session", sessionId: "session-1" })).toBeNull();
    expect(isQueueableDisconnectedMessage({ type: "abort-session", sessionId: "session-1" })).toBe(false);
  });

  it("drops the oldest messages when the queue exceeds its cap", () => {
    const queue: WsMessage[] = [];

    enqueueDisconnectedMessage(queue, { type: "check-session-status", sessionId: "session-1" }, 2);
    enqueueDisconnectedMessage(queue, { type: "check-session-status", sessionId: "session-2" }, 2);
    enqueueDisconnectedMessage(queue, { type: "check-session-status", sessionId: "session-3" }, 2);

    expect(queue.map(message => message.sessionId)).toEqual(["session-2", "session-3"]);
  });

  it("clears queued messages on provider cleanup so old token messages cannot flush later", () => {
    const queue: WsMessage[] = [];

    enqueueDisconnectedMessage(queue, { type: "sati-command", text: "stale" });
    enqueueDisconnectedMessage(queue, { type: "check-session-status", sessionId: "session-1" });

    clearDisconnectedQueue(queue);

    expect(queue).toEqual([]);
  });
});
