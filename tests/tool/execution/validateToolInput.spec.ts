import assert from "node:assert/strict";
import test from "node:test";
import { validateToolInput } from "../../../src/tool/execution/validateToolInput.js";
import type { SatiToolInputSchema } from "../../../src/tool/protocol/schema.js";

test("additionalProperties: false 拒绝未声明键", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    additionalProperties: false,
    properties: { known: { type: "string" } },
  };
  const result = validateToolInput({ known: "a", extra: 1 }, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0].code, "unknown_property");
    assert.equal(result.issues[0].path, "$.extra");
  }
});

test("additionalProperties: true 允许未声明键", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    additionalProperties: true,
    properties: { known: { type: "string" } },
  };
  const result = validateToolInput({ known: "a", anything: { deep: [1, 2] } }, schema);
  assert.deepEqual(result, { ok: true, input: { known: "a", anything: { deep: [1, 2] } } });
});

test("additionalProperties: 对象 schema 校验未声明键类型", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    additionalProperties: { type: "string" },
    properties: { known: { type: "number" } },
  };
  const ok = validateToolInput({ known: 1, extra: "x" }, schema);
  assert.deepEqual(ok, { ok: true, input: { known: 1, extra: "x" } });

  const bad = validateToolInput({ extra: 5 }, schema);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.issues[0].code, "invalid_type");
    assert.equal(bad.issues[0].path, "$.extra");
  }
});

test("additionalProperties: 对象 schema 支持嵌套枚举约束", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    additionalProperties: {
      type: "object",
      additionalProperties: false,
      properties: { kind: { type: "string", enum: ["a", "b"] } },
    },
  };
  const ok = validateToolInput({ one: { kind: "a" } }, schema);
  assert.equal(ok.ok, true);

  const badEnum = validateToolInput({ one: { kind: "c" } }, schema);
  assert.equal(badEnum.ok, false);
  if (!badEnum.ok) assert.equal(badEnum.issues[0].code, "invalid_enum");

  const badExtra = validateToolInput({ one: { kind: "a", other: 1 } }, schema);
  assert.equal(badExtra.ok, false);
  if (!badExtra.ok) assert.equal(badExtra.issues[0].code, "unknown_property");
});

test("additionalProperties: 未声明时保持旧行为（不校验额外键）", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    properties: { known: { type: "string" } },
  };
  const result = validateToolInput({ known: "a", extra: 1 }, schema);
  assert.equal(result.ok, true);
});

test("additionalProperties: 数组 items 与对象属性同时生效", () => {
  const schema: SatiToolInputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      list: {
        type: "array",
        items: { type: "object", additionalProperties: { type: "integer" } },
      },
    },
  };
  const ok = validateToolInput({ list: [{ a: 1 }, { b: 2 }] }, schema);
  assert.equal(ok.ok, true);

  const bad = validateToolInput({ list: [{ a: "str" }] }, schema);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.issues[0].code, "invalid_type");
});
