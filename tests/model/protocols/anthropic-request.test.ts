import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildModelRequest } from "../../../src/model/request/buildModelRequest.js";
import type { CanonicalModelRequest, CanonicalMessage } from "../../../src/model/protocol/canonical.js";
import { validModelConfig } from "../helpers.js";

test("builds Anthropic messages request from canonical request", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const request: CanonicalModelRequest = {
    provider: "anthropic-main",
    model: "claude-sonnet-4-5",
    systemPrompt: "You are helpful.",
    maxOutputTokens: 1024,
    thinking: { enabled: true, budgetTokens: 256 },
    stream: true,
    tools: [
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Find news" }],
      },
    ],
  };

  const body = buildModelRequest(request, config) as Record<string, any>;

  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.system, "You are helpful.");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.thinking.type, "enabled");
  assert.equal(body.messages[0].content[0].type, "text");
  assert.equal(body.tools[0].input_schema.type, "object");
});

test("A4 cacheBreakpoints lower to cache_control: ephemeral on the last block", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const body = buildModelRequest(
    {
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ack" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
      cacheBreakpoints: [1],
    },
    config,
  ) as Record<string, any>;
  assert.equal(body.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(body.messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.equal(body.messages[2].content[0].cache_control, undefined);
});

test("tool_result_reference is converted to Anthropic tool_result with preview", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "read big file" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "/big.json" } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result_reference",
          toolCallId: "call-1",
          path: "/tmp/tool-results/call-1.json",
          originalBytes: 80000,
          preview: '{"key": "first 2KB..."}',
          hasMore: true,
          mimeType: "application/json",
          reason: "tool_result_too_large",
        },
      ],
    },
  ];

  const body = buildModelRequest(
    { provider: "anthropic-main", model: "claude-sonnet-4-5", messages },
    config,
  ) as Record<string, any>;

  const lastMsg = body.messages[2];
  assert.equal(lastMsg.role, "user");
  const toolBlock = lastMsg.content[0];
  assert.equal(toolBlock.type, "tool_result");
  assert.equal(toolBlock.tool_use_id, "call-1");
  assert.ok(
    toolBlock.content[0].text.includes('{"key": "first 2KB..."}'),
    "should contain the preview text",
  );
  assert.ok(
    toolBlock.content[0].text.includes("[Truncated: original 80000 bytes"),
    "should contain truncation notice",
  );
  assert.equal(toolBlock.is_error, false);
});

test("A4 cacheBreakpoints absent → no cache_control emitted (regression)", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const body = buildModelRequest(
    {
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    },
    config,
  ) as Record<string, any>;
  assert.equal(body.messages[0].content[0].cache_control, undefined);
});

test("tool_result preserves multimodal image and pdf blocks for Anthropic", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const body = buildModelRequest(
    {
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      messages: [
        { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            toolCallId: "call-1",
            content: [
              { type: "text", text: "preview" },
              { type: "image", source: "base64", mimeType: "image/png", data: "abc", bytes: 3 },
              { type: "pdf", source: "base64", mimeType: "application/pdf", data: "def", bytes: 3, pages: 1 },
            ],
          }],
        },
      ],
    },
    config,
  ) as Record<string, any>;

  const toolResult = body.messages[1].content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "call-1");
  assert.equal(toolResult.content[0].type, "text");
  assert.equal(toolResult.content[1].type, "image");
  assert.equal(toolResult.content[2].type, "document");
});
