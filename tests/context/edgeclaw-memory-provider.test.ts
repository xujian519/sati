import test from "node:test";
import assert from "node:assert/strict";
import {
  EdgeClawMemoryProvider,
  canonicalMessagesToMemoryMessages,
  type EdgeClawMemoryServiceLike,
} from "../../src/context/index.js";

test("canonicalMessagesToMemoryMessages extracts text and tool_result content", () => {
  const messages = canonicalMessagesToMemoryMessages([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-1", name: "lookup", input: {} },
        { type: "text", text: "done" },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "tool output" }] }],
    },
  ]);

  assert.deepEqual(messages, [
    { msgId: "message-0", role: "user", content: "hello" },
    { msgId: "message-1", role: "assistant", content: "done" },
    { msgId: "message-2", role: "user", content: "tool output" },
  ]);
});

test("EdgeClawMemoryProvider retrieves system context through service adapter", async () => {
  const calls: unknown[] = [];
  const service: EdgeClawMemoryServiceLike = {
    retrieveContext: async (query, options) => {
      calls.push({ query, options });
      return { systemContext: "remembered context", trace: { ok: true } };
    },
    captureTurn: () => ({ captured: true, normalizedMessages: [], sessionKey: "s" }),
  };
  const provider = new EdgeClawMemoryProvider({ service, retrievalMode: "explicit" });

  const result = await provider.retrieve({
    query: "what matters?",
    sessionId: "s",
    projectRoot: "/repo",
    recentMessages: [{ role: "user", content: [{ type: "text", text: "recent" }] }],
  });

  assert.equal(result.systemContext, "remembered context");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(calls, [
    {
      query: "what matters?",
      options: {
        recentMessages: [{ msgId: "message-0", role: "user", content: "recent" }],
        workspaceHint: "/repo",
        retrievalMode: "explicit",
      },
    },
  ]);
});

test("EdgeClawMemoryProvider captureTurn is best effort", async () => {
  let capturedSessionKey = "";
  const service: EdgeClawMemoryServiceLike = {
    retrieveContext: async () => ({ systemContext: "" }),
    captureTurn: (_messages, input) => {
      capturedSessionKey = input.sessionKey;
      throw new Error("capture failed");
    },
  };
  const provider = new EdgeClawMemoryProvider({
    service,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  await provider.captureTurn({
    sessionId: "session-1",
    projectRoot: "/repo",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });

  assert.equal(capturedSessionKey, "session-1");
});
