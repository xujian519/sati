import test from "node:test";
import assert from "node:assert/strict";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../../src/model/streaming/assembleModelMessage.js";
import {
  createAnthropicStreamState,
  normalizeAnthropicStreamEvent,
} from "../../../src/model/providers/anthropic/stream.js";

test("anthropic stream surfaces signature_delta as thinking_delta with signature", () => {
  const state = createAnthropicStreamState();
  const events = normalizeAnthropicStreamEvent(
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-abc-123" },
    },
    state,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "thinking_delta");
  assert.equal(events[0]?.text, "");
  assert.equal((events[0] as { signature?: string }).signature, "sig-abc-123");
});

test("assembler attaches signature to the produced thinking block", () => {
  const state = createModelMessageAssemblerState();
  applyModelEventToAssembler(state, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(state, { type: "thinking_delta", text: "let me think." });
  applyModelEventToAssembler(state, { type: "thinking_delta", text: "", signature: "sig-xyz" });
  applyModelEventToAssembler(state, { type: "text_delta", text: "answer" });
  applyModelEventToAssembler(state, { type: "message_end", finishReason: "stop" });
  const result = assembleAssistantMessage(state);
  assert.equal(result.message.content.length, 2);
  const thinking = result.message.content[0];
  assert.equal(thinking?.type, "thinking");
  assert.equal((thinking as { text: string }).text, "let me think.");
  assert.equal((thinking as { signature?: string }).signature, "sig-xyz");
  assert.equal(result.message.content[1]?.type, "text");
});

test("assembler emits empty thinking block with signature when only signature_delta arrives", () => {
  const state = createModelMessageAssemblerState();
  applyModelEventToAssembler(state, { type: "thinking_delta", text: "", signature: "sig-only" });
  applyModelEventToAssembler(state, { type: "message_end", finishReason: "stop" });
  const result = assembleAssistantMessage(state);
  const thinking = result.message.content.find((block) => block.type === "thinking");
  assert.ok(thinking);
  assert.equal((thinking as { text: string }).text, "");
  assert.equal((thinking as { signature?: string }).signature, "sig-only");
});
