import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildModelRequest } from "../../../src/model/request/buildModelRequest.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
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
