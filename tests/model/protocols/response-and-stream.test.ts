import test from "node:test";
import assert from "node:assert/strict";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  createStreamNormalizerState,
  normalizeStreamEvent,
  parseModelResponse,
  streamModel,
  parseModelConfig,
  type CanonicalModelRequest,
} from "../../../src/model/index.js";
import { validModelConfig } from "../helpers.js";

test("parses Anthropic tool_use response into canonical tool call", () => {
  const response = parseModelResponse("anthropic", {
    content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  assert.equal(response.finishReason, "tool_call");
  assert.equal(response.usage?.totalTokens, 15);
  assert.deepEqual(response.content[0], {
    type: "tool_call",
    id: "toolu_1",
    name: "search",
    input: { query: "x" },
    raw: { type: "tool_use", id: "toolu_1", name: "search", input: { query: "x" } },
  });
});

test("parses OpenAI tool_call response into canonical tool call", () => {
  const response = parseModelResponse("openai", {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              id: "call_1",
              function: { name: "lookup", arguments: "{\"id\":\"123\"}" },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });

  assert.equal(response.finishReason, "tool_call");
  assert.equal(response.usage?.totalTokens, 7);
  assert.equal(response.content[0].type, "tool_call");
});

test("normalizes OpenAI streaming deltas and assembles tool arguments", () => {
  const state = createStreamNormalizerState();
  const first = normalizeStreamEvent(
    "openai",
    {
      choices: [{ delta: { content: "hello" } }],
    },
    state,
  );
  const toolStart = normalizeStreamEvent(
    "openai",
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "lookup", arguments: "{\"id\":" },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  const end = normalizeStreamEvent(
    "openai",
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: "\"123\"}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    state,
  );

  assert.equal(first[0].type, "message_start");
  assert.equal(first[1].type, "text_delta");
  assert.equal(toolStart[0].type, "tool_call_start");
  assert.equal(end.at(-2)?.type, "tool_call_end");
  assert.equal(end.at(-1)?.type, "message_end");
});

test("normalizes Anthropic streaming tool_use into a complete tool call", () => {
  const state = createStreamNormalizerState();
  const start = normalizeStreamEvent("anthropic", { type: "message_start" }, state);
  const toolStart = normalizeStreamEvent(
    "anthropic",
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "lookup" },
    },
    state,
  );
  const delta = normalizeStreamEvent(
    "anthropic",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"id\":\"123\"}" },
    },
    state,
  );
  const stop = normalizeStreamEvent("anthropic", { type: "content_block_stop", index: 0 }, state);

  assert.equal(start[0].type, "message_start");
  assert.equal(toolStart[0].type, "tool_call_start");
  assert.equal(delta[0].type, "tool_call_delta");
  assert.equal(stop[0].type, "tool_call_end");
  if (stop[0].type === "tool_call_end") {
    assert.deepEqual(stop[0].toolCall, {
      id: "toolu_1",
      name: "lookup",
      input: { id: "123" },
      raw: { type: "content_block_stop", index: 0 },
    });
  }
});

test("assembles canonical stream events into an assistant message", () => {
  const state = createModelMessageAssemblerState();
  for (const event of [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: "Checking." },
    { type: "tool_call_end", toolCall: { id: "call-1", name: "lookup", input: { id: "123" } } },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    { type: "message_end", finishReason: "tool_call" },
  ] as const) {
    applyModelEventToAssembler(state, event);
  }

  const assembled = assembleAssistantMessage(state);

  assert.equal(assembled.finishReason, "tool_call");
  assert.equal(assembled.usage?.totalTokens, 5);
  assert.deepEqual(
    assembled.message.content.map((block) => block.type),
    ["text", "tool_call"],
  );
  assert.deepEqual(assembled.toolCalls[0], { id: "call-1", name: "lookup", input: { id: "123" } });
});

test("streamModel forwards external abort signal to the transport", async () => {
  const raw = validModelConfig();
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const request: CanonicalModelRequest = {
    provider: "anthropic-main",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const controller = new AbortController();
  controller.abort("test abort");
  let transportSawAbortedSignal = false;

  const events = [];
  for await (const event of streamModel(request, config, {
    signal: controller.signal,
    fetch: async (_url, init) => {
      transportSawAbortedSignal = init?.signal instanceof AbortSignal && init.signal.aborted;
      return new Response(
        new ReadableStream({
          start(streamController) {
            streamController.close();
          },
        }),
        { status: 200 },
      );
    },
  })) {
    events.push(event);
  }

  assert.equal(transportSawAbortedSignal, true);
  assert.equal(events[0]?.type, "request_started");
});
