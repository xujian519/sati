import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildModelRequest } from "../../../src/model/request/buildModelRequest.js";
import {
  ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
  extractStructuredOutput,
} from "../../../src/model/index.js";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalOutputSchema,
} from "../../../src/model/protocol/canonical.js";
import { validModelConfig } from "../helpers.js";

const sampleSchema: CanonicalOutputSchema = {
  name: "diff_summary",
  description: "Summary of a code diff.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "score"],
    properties: {
      summary: { type: "string" },
      score: { type: "number" },
    },
  },
};

test("A3.OpenAI buildOpenAIRequest emits response_format with strict=true by default", () => {
  const config = parseModelConfig(validModelConfig(), { env: { ANTHROPIC_API_KEY: "anthropic-key" } });
  const request: CanonicalModelRequest = {
    provider: "openai-main",
    model: "gpt-5.1",
    messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
    outputSchema: sampleSchema,
  };
  const body = buildModelRequest(request, config) as Record<string, any>;
  assert.equal(body.response_format?.type, "json_schema");
  assert.equal(body.response_format?.json_schema?.name, "diff_summary");
  assert.equal(body.response_format?.json_schema?.strict, true);
  assert.deepEqual(body.response_format?.json_schema?.schema, sampleSchema.schema);
});

test("A3.OpenAI strict=false is forwarded verbatim", () => {
  const config = parseModelConfig(validModelConfig(), { env: { ANTHROPIC_API_KEY: "anthropic-key" } });
  const body = buildModelRequest(
    {
      provider: "openai-main",
      model: "gpt-5.1",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      outputSchema: { ...sampleSchema, strict: false },
    },
    config,
  ) as Record<string, any>;
  assert.equal(body.response_format?.json_schema?.strict, false);
});

test("A3.Anthropic injects forced __output__ tool with tool_choice=tool", () => {
  const config = parseModelConfig(validModelConfig(), { env: { ANTHROPIC_API_KEY: "anthropic-key" } });
  const body = buildModelRequest(
    {
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      outputSchema: sampleSchema,
    },
    config,
  ) as Record<string, any>;
  const outputTool = body.tools?.find(
    (t: { name: string }) => t.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
  );
  assert.ok(outputTool, "expected hidden __output__ tool to be injected");
  assert.deepEqual(outputTool.input_schema, sampleSchema.schema);
  assert.deepEqual(body.tool_choice, { type: "tool", name: "__output__" });
});

test("A3.Anthropic strict=false leaves user toolChoice in place", () => {
  const config = parseModelConfig(validModelConfig(), { env: { ANTHROPIC_API_KEY: "anthropic-key" } });
  const body = buildModelRequest(
    {
      provider: "anthropic-main",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      toolChoice: "auto",
      outputSchema: { ...sampleSchema, strict: false },
    },
    config,
  ) as Record<string, any>;
  const outputTool = body.tools?.find(
    (t: { name: string }) => t.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
  );
  assert.ok(outputTool, "tool still injected");
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("A3.extractStructuredOutput parses Anthropic tool_use payload", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "tu_1",
        name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
        input: { summary: "ok", score: 5 },
      },
    ],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { summary: "ok", score: 5 });
  }
});

test("A3.extractStructuredOutput parses OpenAI JSON-encoded text", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [{ type: "text", text: '{"summary":"ok","score":5}' }],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { summary: "ok", score: 5 });
  }
});

test("A3.extractStructuredOutput rejects invalid JSON", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [{ type: "text", text: "not-json" }],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_json");
  }
});

test("A3.extractStructuredOutput rejects multiple __output__ tool_use blocks", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [
      { type: "tool_call", id: "1", name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME, input: {} },
      { type: "tool_call", id: "2", name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME, input: {} },
    ],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "multiple_payloads");
  }
});

test("A3.extractStructuredOutput honors a custom validator", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [{ type: "text", text: '{"x":1}' }],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response, {
    validate: (v) => typeof v === "object" && v !== null && "y" in v,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "schema_mismatch");
  }
});

test("A3.extractStructuredOutput returns no_payload when assistant is empty", () => {
  const response: CanonicalModelResponse = {
    role: "assistant",
    content: [],
    finishReason: "stop",
  };
  const result = extractStructuredOutput(response);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no_payload");
  }
});
