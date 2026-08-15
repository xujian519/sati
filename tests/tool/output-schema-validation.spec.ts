/**
 * canonical 输出契约测试（阶段四 T9）。
 *
 * 覆盖：校验器子集语义（required/type/enum/items/additionalProperties）、
 * 注册表 requireOutputSchema fail-loud、真实专利工具产物过自身 schema。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalOutput } from "../../src/tool/execution/outputSchemaValidation.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { draftClaims, createDraftClaimsTool } from "../../src/tool/builtin/draftClaims.js";
import { draftSpecification, createDraftSpecificationTool } from "../../src/tool/builtin/draftSpecification.js";
import type { SatiToolDefinition } from "../../src/tool/protocol/types.js";

const SAMPLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    mode: { type: "string", enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["name", "mode"],
};

test("合法输出：零违约", () => {
  assert.deepEqual(validateCanonicalOutput({ name: "x", mode: "a", tags: ["t1"] }, SAMPLE_SCHEMA), []);
});

test("缺失 required 属性：报出路径", () => {
  const violations = validateCanonicalOutput({ mode: "a" }, SAMPLE_SCHEMA);
  assert.equal(violations.length, 1);
  assert.match(String(violations[0]), /\$.name: missing required/);
});

test("类型违约与 enum 违约：路径可读", () => {
  const typeViolations = validateCanonicalOutput({ name: 42, mode: "a" }, SAMPLE_SCHEMA);
  assert.match(String(typeViolations[0]), /\$.name: expected type string/);
  const enumViolations = validateCanonicalOutput({ name: "x", mode: "z" }, SAMPLE_SCHEMA);
  assert.match(String(enumViolations[0]), /\$.mode: not one of the allowed enum values/);
});

test("additionalProperties false 与嵌套 items 违约", () => {
  const extraViolations = validateCanonicalOutput({ name: "x", mode: "a", extra: 1 }, SAMPLE_SCHEMA);
  assert.match(String(extraViolations[0]), /\$.extra: additional property not allowed/);
  const itemViolations = validateCanonicalOutput({ name: "x", mode: "a", tags: ["ok", 3] }, SAMPLE_SCHEMA);
  assert.match(String(itemViolations[0]), /\$.tags\[1\]: expected type string/);
});

test("注册表 requireOutputSchema：缺 schema fail-loud、有 schema 通过、默认关闭", () => {
  const strict = new ToolRegistry({ requireOutputSchema: true });
  const noSchema: SatiToolDefinition = {
    name: "legacy_tool",
    description: "no schema",
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
  assert.throws(() => strict.register(noSchema), /missing its canonical outputSchema/);
  strict.register({ ...noSchema, name: "declared_tool", outputSchema: { type: "object" } });
  assert.equal(strict.has("declared_tool"), true);
  const lenient = new ToolRegistry();
  lenient.register(noSchema);
  assert.equal(lenient.has("legacy_tool"), true);
});

test("真实专利工具产物过自身 schema（draft_claims）", () => {
  const tool = createDraftClaimsTool();
  assert.ok(tool.outputSchema);
  const output = draftClaims({
    invention_name: "一种散热装置",
    technical_features: ["散热片", "风扇"],
    optional_features: ["温度传感器"],
  });
  assert.deepEqual(validateCanonicalOutput(output, tool.outputSchema!), []);
});

test("真实专利工具产物过自身 schema（draft_specification）", () => {
  const tool = createDraftSpecificationTool();
  assert.ok(tool.outputSchema);
  const output = draftSpecification({ title: "一种散热装置" });
  assert.deepEqual(validateCanonicalOutput(output, tool.outputSchema!), []);
});
