import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../src/model/providers/openai/stream.js";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../../src/model/streaming/assembleModelMessage.js";

test("OpenAI provider maps OpenRouter delta.reasoning to thinking_delta", () => {
  const state = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent(
    {
      choices: [
        { index: 0, delta: { content: "", role: "assistant", reasoning: "Let me think." }, finish_reason: null },
      ],
    },
    state,
  );
  const thinking = events.filter((event) => event.type === "thinking_delta");
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0] as { text: string }).text, "Let me think.");
});

test("OpenAI provider preserves reasoning + content + tool_call ordering for Kimi-style chunks", () => {
  const state = createOpenAIStreamState();
  const chunks = [
    { choices: [{ index: 0, delta: { content: "", role: "assistant", reasoning: "Step 1." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", role: "assistant", reasoning: " Step 2." }, finish_reason: null }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "id1",
                type: "function",
                function: { name: "smoke", arguments: '{"a":1}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "tool_calls" }] },
  ];
  const ordered: string[] = [];
  for (const chunk of chunks) {
    for (const event of normalizeOpenAIStreamEvent(chunk, state)) {
      ordered.push(event.type);
    }
  }
  // message_start + 2 thinking_delta + tool_call_start + tool_call_delta + tool_call_end + message_end
  assert.deepEqual(ordered, [
    "message_start",
    "thinking_delta",
    "thinking_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_end",
    "message_end",
  ]);
});

test("Assembler folds reasoning into a thinking block alongside tool_call output", () => {
  const stream = createOpenAIStreamState();
  const assembler = createModelMessageAssemblerState();
  const chunks = [
    { choices: [{ index: 0, delta: { content: "", role: "assistant", reasoning: "Plan A." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "answer", role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }] },
  ];
  for (const chunk of chunks) {
    for (const event of normalizeOpenAIStreamEvent(chunk, stream)) {
      applyModelEventToAssembler(assembler, event);
    }
  }
  const result = assembleAssistantMessage(assembler);
  assert.equal(result.message.content[0]?.type, "thinking");
  assert.equal((result.message.content[0] as { text: string }).text, "Plan A.");
  assert.equal(result.message.content[1]?.type, "text");
  assert.equal((result.message.content[1] as { text: string }).text, "answer");
});
