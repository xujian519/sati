import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIRequest } from "../../../../src/model/providers/openai/request.js";
import type {
  CanonicalModelRequest,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../../../src/model/protocol/multimodal.js";

const TEST_MODEL: ModelDefinition = {
  id: "openai/test",
  capabilities: {
    ...DEFAULT_MODEL_CAPABILITIES,
    maxOutputTokens: 1024,
  },
  multimodal: DEFAULT_MULTIMODAL_CONSTRAINTS,
};

function createRequest(tools: CanonicalToolSchema[]): CanonicalModelRequest {
  return {
    model: "openai/test",
    provider: "openai",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools,
  };
}

test("buildOpenAIRequest normalizes array-union tool schema nodes missing items", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      value: {
        type: ["object", "array", "string", "number", "boolean"],
      },
      status: {
        type: ["string", "array"],
      },
      nested: {
        oneOf: [
          { type: ["array", "null"] },
          {
            type: "object",
            properties: {
              tags: { type: ["string", "array"] },
            },
          },
        ],
      },
    },
  } as Record<string, unknown>;

  const request = createRequest([{ name: "task_like_tool", inputSchema: schema }]);
  const body = buildOpenAIRequest(request, TEST_MODEL);
  const params = body.tools?.[0]?.function.parameters as Record<string, unknown>;
  const properties = params.properties as Record<string, unknown>;

  assert.deepEqual((properties.value as Record<string, unknown>).items, {});
  assert.deepEqual((properties.status as Record<string, unknown>).items, {});

  const nested = properties.nested as Record<string, unknown>;
  const oneOf = nested.oneOf as Array<Record<string, unknown>>;
  assert.deepEqual(oneOf[0].items, {});

  const nestedProps = (oneOf[1].properties as Record<string, unknown>);
  assert.deepEqual((nestedProps.tags as Record<string, unknown>).items, {});
});

test("buildOpenAIRequest preserves existing items and does not mutate original schema", () => {
  const schema = {
    type: "object",
    properties: {
      ids: {
        type: ["array", "string"],
      },
      labels: {
        type: "array",
        items: { type: "string" },
      },
    },
  } as Record<string, unknown>;

  const request = createRequest([{ name: "mixed_tool", inputSchema: schema }]);
  const body = buildOpenAIRequest(request, TEST_MODEL);
  const params = body.tools?.[0]?.function.parameters as Record<string, unknown>;
  const properties = params.properties as Record<string, unknown>;

  assert.deepEqual((properties.ids as Record<string, unknown>).items, {});
  assert.deepEqual((properties.labels as Record<string, unknown>).items, { type: "string" });

  const originalProps = schema.properties as Record<string, unknown>;
  assert.equal((originalProps.ids as Record<string, unknown>).items, undefined);
  assert.deepEqual((originalProps.labels as Record<string, unknown>).items, { type: "string" });
});
