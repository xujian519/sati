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

test("tool_result preserves multimodal image and pdf blocks for OpenAI", () => {
  const raw = validModelConfig();
  const providers = raw.providers as {
    "openai-main": {
      models: {
        "gpt-5.1": {
          multimodal: { input: string[] };
        };
      };
    };
  };
  providers["openai-main"].models["gpt-5.1"].multimodal.input = ["text", "image", "audio", "pdf"];
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const body = buildModelRequest(
    {
      provider: "openai-main",
      model: "gpt-5.1",
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

  const toolMessage = body.messages.find((m: any) => m.role === "tool");
  assert.ok(toolMessage, "should emit a tool role message");
  assert.ok(Array.isArray(toolMessage.content), "multimodal tool_result should stay structured");
  assert.equal(toolMessage.content[0].type, "text");
  assert.equal(toolMessage.content[1].type, "image_url");
  assert.equal(toolMessage.content[2].type, "file");
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

test("user message with tool_result before directive serializes tool result before user text", () => {
  const config = parseModelConfig(validModelConfig(), {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "forking" },
        { type: "tool_call", id: "call-1", name: "agent", input: { prompt: "work" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "<pilotdeck-fork-placeholder />" }],
        },
        { type: "text", text: "<pilotdeck-fork>\nDirective:\nwork\n</pilotdeck-fork>" },
      ],
    },
  ];

  const body = buildModelRequest(
    { provider: "openai-main", model: "gpt-5.1", messages },
    config,
  ) as Record<string, any>;

  assert.deepEqual(
    body.messages.map((m: any) => [m.role, m.tool_call_id ?? null, m.content]),
    [
      ["assistant", null, "forking"],
      ["tool", "call-1", "<pilotdeck-fork-placeholder />"],
      ["user", null, "<pilotdeck-fork>\nDirective:\nwork\n</pilotdeck-fork>"],
    ],
  );
  assert.equal(
    body.messages.filter((m: any) => m.role === "tool" && m.tool_call_id === "call-1").length,
    1,
    "should not inject a duplicate placeholder tool result",
  );
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

test("tool result images are appended after contiguous OpenAI tool messages", () => {
  const raw = validModelConfig();
  const providers = raw.providers as Record<string, any>;
  providers["openai-main"].models["gpt-5.1"].multimodal.input = ["text", "image"];
  const config = parseModelConfig(raw, {
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  });
  const messages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-1", name: "screenshot", input: {} },
        { type: "tool_call", id: "call-2", name: "read_file", input: { path: "a.txt" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-1",
          content: [
            { type: "text", text: "Screenshot captured." },
            { type: "image", source: "base64", mimeType: "image/png", data: "abc123" },
          ],
        },
        {
          type: "tool_result",
          toolCallId: "call-2",
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    },
  ];

  const body = buildModelRequest(
    { provider: "openai-main", model: "gpt-5.1", messages },
    config,
  ) as Record<string, any>;

  assert.deepEqual(
    body.messages.map((m: any) => [m.role, m.tool_call_id ?? null]),
    [
      ["assistant", null],
      ["tool", "call-1"],
      ["tool", "call-2"],
      ["user", null],
    ],
  );
  assert.equal(body.messages[1].content, "Screenshot captured.\n[Image: image/png, 6 base64 characters]");
  assert.equal(body.messages[2].content, "file contents");
  assert.deepEqual(body.messages[3].content, [
    { type: "text", text: "[Visual content from tool result]" },
    {
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,abc123",
        detail: undefined,
      },
    },
  ]);
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
