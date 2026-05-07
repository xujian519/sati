import test from "node:test";
import assert from "node:assert/strict";
import { validateToolInput, type PolitDeckToolInputSchema } from "../../src/tool/index.js";

const schema: PolitDeckToolInputSchema = {
  type: "object",
  required: ["query", "limit"],
  additionalProperties: false,
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    mode: { type: "string", enum: ["content", "count"] },
    nested: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
      },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
  },
};

test("accepts valid tool input", () => {
  const result = validateToolInput(
    { query: "hello", limit: 3, mode: "content", nested: { enabled: true }, tags: ["a"] },
    schema,
  );

  assert.equal(result.ok, true);
});

test("reports required, unknown property, type, enum and array item issues", () => {
  const result = validateToolInput(
    { query: 1, extra: true, limit: 1.2, mode: "bad", nested: {}, tags: ["a", 2] },
    schema,
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["unknown_property", "invalid_type", "invalid_type", "invalid_enum", "required", "invalid_type"],
    );
  }
});

test("rejects non-object root input", () => {
  const result = validateToolInput("bad", schema);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0]?.code, "invalid_type");
  }
});
