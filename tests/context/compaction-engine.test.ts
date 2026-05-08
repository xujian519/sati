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
  assert.equal(model.requests[0]?.systemPrompt?.includes("summarizing conversations"), true);
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
