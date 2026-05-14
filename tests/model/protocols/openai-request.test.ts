import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { ModelRequestError } from "../../../src/model/protocol/errors.js";
import type { CanonicalModelRequest, CanonicalMessage } from "../../../src/model/protocol/canonical.js";
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

test("tool_result_reference is converted to role:tool message with preview", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "read a big file" }],
    },
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
          originalBytes: 120000,
          preview: '{"data": "first 2KB of content..."}',
          hasMore: true,
          mimeType: "application/json",
          reason: "tool_result_too_large",
        },
      ],
    },
  ];

  const body = buildModelRequest(
    { provider: "openai-main", model: "gpt-5.1", messages },
    config,
  ) as Record<string, any>;

  const toolMessages = body.messages.filter((m: any) => m.role === "tool");
  assert.equal(toolMessages.length, 1, "should have exactly one tool message");
  assert.equal(toolMessages[0].tool_call_id, "call-1");
  assert.ok(
    toolMessages[0].content.includes('{"data": "first 2KB of content..."}'),
    "tool message should contain the preview",
  );
  assert.ok(
    toolMessages[0].content.includes("[Truncated: original 120000 bytes"),
    "tool message should include truncation notice",
  );
});

test("tool_result_reference is excluded from normalContent (not duplicated)", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "context" },
        {
          type: "tool_result_reference",
          toolCallId: "call-1",
          path: "/tmp/call-1.txt",
          originalBytes: 60000,
          preview: "preview text",
          hasMore: true,
        },
      ],
    },
  ];

  const body = buildModelRequest(
    {
      provider: "openai-main",
      model: "gpt-5.1",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", input: {} }] },
        ...messages,
      ],
    },
    config,
  ) as Record<string, any>;

  const userMsgs = body.messages.filter((m: any) => m.role === "user");
  for (const m of userMsgs) {
    if (typeof m.content === "string") continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        assert.notEqual(block.type, "tool_result_reference",
          "tool_result_reference should not appear in normalContent");
      }
    }
  }
});

test("thinking-only assistant message serializes content as empty string for DeepSeek", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "think about this" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "Let me reason through this..." },
      ],
    },
    { role: "user", content: [{ type: "text", text: "what did you conclude?" }] },
  ];

  const body = buildModelRequest(
    { provider: "openai-main", model: "gpt-5.1", messages },
    config,
  ) as Record<string, any>;

  const assistantMsg = body.messages.find((m: any) => m.role === "assistant");
  assert.ok(assistantMsg, "should have an assistant message");
  assert.equal(assistantMsg.content, "", "thinking-only assistant should have empty string content");
  assert.equal(assistantMsg.reasoning_content, "Let me reason through this...");
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
