import test from "node:test";
import assert from "node:assert/strict";
import {
  EdgeClawMemoryProvider,
  canonicalMessagesToMemoryMessages,
  type EdgeClawMemoryServiceLike,
} from "../../src/context/index.js";

test("canonicalMessagesToMemoryMessages keeps user text separate from tool results", () => {
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
    {
      role: "user",
      content: [
        {
          type: "tool_result_reference",
          toolCallId: "call-2",
          path: "/tmp/tool-output.txt",
          originalBytes: 100,
          preview: "persisted tool output",
          hasMore: true,
        },
        { type: "text", text: "actual user follow-up" },
      ],
    },
  ]);

  assert.deepEqual(messages, [
    { msgId: "message-0", role: "user", content: "hello" },
    { msgId: "message-1", role: "assistant", content: "done" },
    { msgId: "message-2", role: "tool", content: "tool output" },
    { msgId: "message-3:0", role: "tool", content: "persisted tool output" },
    { msgId: "message-3:1", role: "user", content: "actual user follow-up" },
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
        signal: undefined,
      },
    },
  ]);
});

test("EdgeClawMemoryProvider persists recall case trace on capture", async () => {
  let savedTrace: unknown;
  const service: EdgeClawMemoryServiceLike = {
    retrieveContext: async () => ({
      systemContext: "remembered context",
      context: "remembered context",
      intent: "user",
      trace: { traceId: "trace-1" },
      debug: { mode: "llm", route: "user" },
    }),
    captureTurn: () => ({ captured: true, normalizedMessages: [], sessionKey: "session-1" }),
    saveCaseTrace: (record) => {
      savedTrace = record;
    },
  };
  const provider = new EdgeClawMemoryProvider({
    service,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  await provider.retrieve({
    query: "who am I?",
    sessionId: "session-1",
    projectRoot: "/repo",
    recentMessages: [{ role: "user", content: [{ type: "text", text: "who am I?" }] }],
  });
  await provider.captureTurn({
    sessionId: "session-1",
    projectRoot: "/repo",
    messages: [
      { role: "user", content: [{ type: "text", text: "who am I?" }] },
      { role: "assistant", content: [{ type: "text", text: "You are Zhang San." }] },
    ],
    errored: false,
  });

  assert.deepEqual(savedTrace, {
    sessionKey: "session-1",
    query: "who am I?",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    retrieval: {
      intent: "user",
      injected: true,
      contextPreview: "remembered context",
      trace: { traceId: "trace-1" },
    },
    toolEvents: [],
    assistantReply: "You are Zhang San.",
  });
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
    errored: false,
  });

  assert.equal(capturedSessionKey, "session-1");
});
