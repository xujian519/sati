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

test("parses OpenAI response with array content into canonical text", () => {
  const response = parseModelResponse("openai", {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });

  assert.equal(response.content.length, 2);
  assert.equal(response.content[0].type, "text");
  assert.equal((response.content[0] as { type: "text"; text: string }).text, "Hello ");
  assert.equal((response.content[1] as { type: "text"; text: string }).text, "world");
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

test("OpenAI reasoning deltas: emits each incremental delta exactly once", () => {
  // Bug regression: DeepSeek's native API uses `delta.reasoning_content`.
  // An earlier version of the parser pushed it twice (once via the
  // `reasoning ?? reasoning_content` branch, once via the
  // reasoning_content-specific branch).
  const state = createStreamNormalizerState();
  const events: Array<ReturnType<typeof normalizeStreamEvent>[number]> = [];
  for (const chunk of ["So ", "the ", "answer."]) {
    events.push(...normalizeStreamEvent("openai", { choices: [{ delta: { reasoning_content: chunk } }] }, state));
  }
  const reasoning = events.filter((e) => e.type === "thinking_delta") as Array<{ type: "thinking_delta"; text: string }>;
  assert.deepEqual(
    reasoning.map((e) => e.text),
    ["So ", "the ", "answer."],
    "should emit each incremental delta once, no duplicates",
  );
});

test("OpenAI reasoning deltas: collapses cumulative-snapshot streams to diffs", () => {
  // Bug regression: Yeysai's Gemini wrapper (and similar proxies) emit
  // cumulative reasoning content per chunk — each delta carries
  // "everything emitted so far", not just the new piece. Without diff
  // detection the thinking buffer balloons triangularly (N tokens
  // render N×(N+1)/2 chars).
  const state = createStreamNormalizerState();
  const events: Array<ReturnType<typeof normalizeStreamEvent>[number]> = [];
  for (const snapshot of ["So", "So the", "So the only", "So the only answer"]) {
    events.push(...normalizeStreamEvent("openai", { choices: [{ delta: { reasoning: snapshot } }] }, state));
  }
  const reasoning = events.filter((e) => e.type === "thinking_delta") as Array<{ type: "thinking_delta"; text: string }>;
  assert.deepEqual(
    reasoning.map((e) => e.text),
    ["So", " the", " only", " answer"],
    "snapshot stream should produce suffix-diff deltas, never repeating earlier prefix",
  );
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

test("streamModel stops before provider transport when the external signal is already aborted", async () => {
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
  let transportCalled = false;

  const iterator = streamModel(request, config, {
    signal: controller.signal,
    fetch: async (_url, init) => {
      void init;
      transportCalled = true;
      return new Response(
        new ReadableStream({
          start(streamController) {
            streamController.close();
          },
        }),
        { status: 200 },
      );
    },
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "request_started");
  await assert.rejects(iterator.next(), /abort/i);
  assert.equal(transportCalled, false);
});

test("streamModel cancels an in-flight SSE body when the external signal aborts", async () => {
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
  let bodyCancelled = false;

  const iterator = streamModel(request, config, {
    signal: controller.signal,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      ),
  })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "request_started",
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      metadata: undefined,
    },
  });

  const pendingRead = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("user requested stop");

  await assert.rejects(pendingRead, /abort|stop|cancel/i);
  assert.equal(bodyCancelled, true);
});
