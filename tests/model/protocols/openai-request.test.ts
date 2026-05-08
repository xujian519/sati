import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { ModelRequestError } from "../../../src/model/protocol/errors.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { buildModelRequest } from "../../../src/model/request/buildModelRequest.js";
import { validModelConfig } from "../helpers.js";

test("builds OpenAI chat completions request from canonical request", () => {
  const raw = validModelConfig();
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const request: CanonicalModelRequest = {
    provider: "openai-main",
    model: "gpt-5.1",
    systemPrompt: "You are helpful.",
    maxOutputTokens: 512,
    tools: [
      {
        name: "lookup",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image",
            source: "base64",
            data: "abc",
            mimeType: "image/png",
          },
        ],
      },
    ],
  };

  const body = buildModelRequest(request, config) as Record<string, any>;

  assert.equal(body.model, "gpt-5.1");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.equal(body.tools[0].function.name, "lookup");
});

test("rejects unsupported multimodal input before provider request", () => {
  const raw = validModelConfig();
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const request: CanonicalModelRequest = {
    provider: "anthropic-main",
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "audio",
            source: "base64",
            data: "abc",
            mimeType: "audio/wav",
          },
        ],
      },
    ],
  };

  assert.throws(
    () => buildModelRequest(request, config),
    (error) => error instanceof ModelRequestError && error.code === "unsupported_modality",
  );
});
