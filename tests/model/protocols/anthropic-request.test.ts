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
