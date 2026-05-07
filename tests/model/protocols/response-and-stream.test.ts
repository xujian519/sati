import test from "node:test";
import assert from "node:assert/strict";
import { parseModelResponse } from "../../../src/model/response/parseModelResponse.js";
import {
  createStreamNormalizerState,
  normalizeStreamEvent,
} from "../../../src/model/streaming/normalizeStreamEvent.js";

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
