import test from "node:test";
import assert from "node:assert/strict";
import {
  CompactionEngine,
  buildPostCompactMessages,
  truncateHead,
} from "../../src/context/compaction/CompactionEngine.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";

class ScriptedModel {
  readonly requests: CanonicalModelRequest[] = [];
  constructor(private readonly script: CanonicalModelEvent[]) {}
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    for (const event of this.script) {
      yield event;
    }
  }
}

const baseMessages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "a".repeat(2000) }] },
  { role: "assistant", content: [{ type: "text", text: "first reply" }] },
  { role: "user", content: [{ type: "text", text: "b".repeat(2000) }] },
  { role: "assistant", content: [{ type: "text", text: "second reply" }] },
];

test("CompactionEngine.run summarizes via stream and emits boundary marker", async () => {
  const model = new ScriptedModel([
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: "Summary of the conversation." },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 } },
    { type: "message_end", finishReason: "stop" },
  ]);
  const engine = new CompactionEngine({ model, provider: "test", model_: "test-model" });
  const result = await engine.run({ trigger: "auto", messages: baseMessages, keepTailRatio: 0.25 });
  assert.equal(result.error, undefined);
  assert.ok(result.summaryMessage);
  assert.equal((result.summaryMessage!.content[0] as { text: string }).text, "Summary of the conversation.");
  assert.match((result.boundaryMarker.content[0] as { text: string }).text, /<compact-boundary/);
  assert.ok(result.preTokens > 0);
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0]?.systemPrompt?.includes("conversation summarizer"), true);
});

test("buildPostCompactMessages preserves legacy ordering", () => {
  const result = {
    trigger: "manual" as const,
    preTokens: 0,
    boundaryMarker: { role: "user" as const, content: [{ type: "text" as const, text: "B" }] },
    summaryMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "S" }] },
    messagesToKeep: [{ role: "user" as const, content: [{ type: "text" as const, text: "K" }] }],
    attachments: [{ role: "user" as const, content: [{ type: "text" as const, text: "A" }] }],
    hookResults: [{ role: "user" as const, content: [{ type: "text" as const, text: "H" }] }],
    diagnostics: [],
  };
  const out = buildPostCompactMessages(result);
  assert.deepEqual(
    out.map((m) => (m.content[0] as { text: string }).text),
    ["B", "S", "K", "A", "H"],
  );
});

test("truncateHead keeps trailing keepRatio portion", () => {
  const ms: CanonicalMessage[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
    role: "user",
    content: [{ type: "text", text: String(i) }],
  }));
  const truncated = truncateHead(ms, 0.25);
  assert.equal(truncated.length, 2);
  assert.equal((truncated[0]!.content[0] as { text: string }).text, "6");
  assert.equal((truncated[1]!.content[0] as { text: string }).text, "7");
});

test("CompactionEngine fires PreCompact and PostCompact lifecycle hooks", async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const lifecycle = {
    dispatch: async (input: { event: "PreCompact" | "PostCompact"; payload: Record<string, unknown> }) => {
      events.push(input);
    },
  };
  const model = new ScriptedModel([{ type: "text_delta", text: "OK" }]);
  const engine = new CompactionEngine({ model, provider: "test", model_: "test-model", lifecycle });
  await engine.run({ trigger: "auto", messages: baseMessages });
  assert.deepEqual(events.map((e) => e.event), ["PreCompact", "PostCompact"]);
  assert.equal(events[1]?.payload.status, "success");
});

test("CompactionEngine reports error in PostCompact payload when summary stream throws", async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const lifecycle = {
    dispatch: async (input: { event: "PreCompact" | "PostCompact"; payload: Record<string, unknown> }) => {
      events.push(input);
    },
  };
  const model = new ScriptedModel([
    { type: "error", error: { provider: "x", protocol: "anthropic", code: "kaboom", message: "boom", retryable: false } },
  ]);
  const engine = new CompactionEngine({ model, provider: "test", model_: "test-model", lifecycle });
  const result = await engine.run({ trigger: "manual", messages: baseMessages });
  assert.equal(result.error, "boom");
  assert.equal(events[1]?.payload.status, "error");
});

test("CompactionEngine strips multimedia before sending to summarizer", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: "Summary" },
  ]);
  const engine = new CompactionEngine({ model, provider: "test", model_: "test-model" });
  const messagesWithMedia: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "read this pdf" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "tc1", name: "read_file", input: { file_path: "test.pdf" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "tc1", content: [{ type: "text", text: "PDF file read: test.pdf" }] }] },
    { role: "user", content: [{ type: "pdf", source: "base64", data: "x".repeat(100000), mimeType: "application/pdf", bytes: 75000 }] },
    { role: "assistant", content: [{ type: "text", text: "I read the pdf" }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ];
  await engine.run({ trigger: "auto", messages: messagesWithMedia, keepTailRatio: 0.2 });
  const sentMessages = model.requests[0]!.messages;
  // Verify no pdf base64 was sent to the summarizer
  for (const msg of sentMessages) {
    for (const block of msg.content) {
      assert.notEqual(block.type, "pdf", "PDF block should have been stripped");
      assert.notEqual(block.type, "image", "Image block should have been stripped");
    }
  }
  // Verify the [document] marker is present
  const pdfReplacementMsg = sentMessages.find((m) =>
    m.content.some((b) => b.type === "text" && "text" in b && (b as { text: string }).text === "[document]"),
  );
  assert.ok(pdfReplacementMsg, "Should have [document] marker replacing PDF");
});
