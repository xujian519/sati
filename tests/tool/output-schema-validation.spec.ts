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
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { builtinPatentManifests } from "../../src/patent/index.js";
import { filterAvailableTools } from "../../src/tool/registry/filterAvailableTools.js";
import { registerToolsIfAbsent } from "../../src/cli/mcpToolRegistration.js";
import { draftClaims, createDraftClaimsTool } from "../../src/tool/builtin/draftClaims.js";
import { draftSpecification, createDraftSpecificationTool } from "../../src/tool/builtin/draftSpecification.js";
import type { SatiToolDefinition } from "../../src/tool/protocol/types.js";

/** 构造一个无 outputSchema 的工具定义（kind 可参数化，用于 MCP 豁免与负控制）。 */
function toolWithoutOutputSchema(name: string, kind: SatiToolDefinition["kind"]): SatiToolDefinition {
  return {
    name,
    description: "no output schema",
    kind,
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

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
  assert.throws(() => strict.register(noSchema), /vacuous canonical outputSchema/);
  assert.throws(
    () => strict.register({ ...noSchema, name: "empty_props", outputSchema: { type: "object", properties: {} } }),
    /vacuous canonical outputSchema \(empty properties\)/,
  );
  assert.throws(
    () => strict.register({ ...noSchema, name: "properties_absent", outputSchema: { type: "object" } }),
    /vacuous canonical outputSchema/,
  );
  strict.register({
    ...noSchema,
    name: "declared_tool",
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  assert.equal(strict.has("declared_tool"), true);
  // 豁免通道：空 schema 必带非空理由；有真实 schema 时豁免即为冗余。
  strict.register({
    ...noSchema,
    name: "exempt_tool",
    outputSchema: { type: "object", properties: {} },
    outputSchemaExemptReason: "legacy text-only output (recorded)",
  });
  assert.equal(strict.has("exempt_tool"), true);
  assert.throws(
    () =>
      strict.register({
        ...noSchema,
        name: "exempt_blank_reason",
        outputSchema: { type: "object", properties: {} },
        outputSchemaExemptReason: "   ",
      }),
    /vacuous canonical outputSchema/,
  );
  assert.throws(
    () =>
      strict.register({
        ...noSchema,
        name: "exempt_redundant",
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        outputSchemaExemptReason: "not needed",
      }),
    /redundant exemption/,
  );
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

// ── #532：严格位必须在派生注册表间传递，且 MCP 工具豁免 ──────────────────────────
//
// 背景：`createBuiltinRegistry` 用 `requireOutputSchema: true` 建表，但 `clone()`、
// `filterAvailableTools()`、子代理 scoped 表都用无参 `new ToolRegistry()` 重建，严格位
// 归零；项目级共享 MCP 工具（无静态可声明的结果形状）撞上严格表会抛错，被
// `ProjectRuntimeRegistry` 的 catch 降级为 warn ⇒ 工具静默消失。修法：① 三处派生表透传
// `registryOptions`；② `register()` 对 `kind === "mcp"` 豁免严格位。

test("#532 clone() 保留严格位：派生表注册非 MCP 无 schema 工具 fail-loud", () => {
  const strict = new ToolRegistry({ requireOutputSchema: true });
  strict.register({
    ...toolWithoutOutputSchema("declared_tool", "custom"),
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  const cloned = strict.clone();

  // 严格位随 clone 传递（这是回归点：无参重建会让它为 undefined）。
  assert.equal(cloned.registryOptions.requireOutputSchema, true);
  // clone 仍持有原工具。
  assert.equal(cloned.has("declared_tool"), true);
  // 在 clone 上注册非 MCP 且无 outputSchema 的工具 ⇒ 抛错（fail-loud）。
  assert.throws(
    () => cloned.register(toolWithoutOutputSchema("late_tool", "custom")),
    /vacuous canonical outputSchema/,
  );

  // 负控制：不带严格位的注册表不会抛 ⇒ 上面的 throw 归因于 clone 透传 options，
  // 而非 register() 无条件抛错（若 clone 退回无参构造，本用例的 throw 断言即变红）。
  const lenient = new ToolRegistry();
  lenient.register(toolWithoutOutputSchema("late_tool", "custom"));
  assert.equal(lenient.has("late_tool"), true);
});

test("#532 filterAvailableTools() 保留严格位", async () => {
  const strict = new ToolRegistry({ requireOutputSchema: true });
  strict.register({
    ...toolWithoutOutputSchema("declared_tool", "custom"),
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  const { registry: filtered } = await filterAvailableTools(strict, { cwd: process.cwd() });

  assert.equal(filtered.registryOptions.requireOutputSchema, true);
  assert.equal(filtered.has("declared_tool"), true);
  // 过滤后的表仍是严格表：注册非 MCP 无 schema 工具 ⇒ 抛错。
  assert.throws(
    () => filtered.register(toolWithoutOutputSchema("late_tool", "custom")),
    /vacuous canonical outputSchema/,
  );
});

test("#532 MCP 工具豁免严格位：注册成功且数量逐一保留（共享 MCP 工具不再被吞）", () => {
  const strict = new ToolRegistry({ requireOutputSchema: true });

  // 模拟 `createMcpToolDefinitionsFromRuntime` 产出的一批 MCP 工具（均无 outputSchema）。
  const mcpDefs = [
    toolWithoutOutputSchema("mcp__server_a__read", "mcp"),
    toolWithoutOutputSchema("mcp__server_a__write", "mcp"),
    toolWithoutOutputSchema("mcp__server_b__query", "mcp"),
  ];

  // 走与 ProjectRuntimeRegistry:438 相同的 `registerToolsIfAbsent` 入口：
  // 修复前 register() 抛错 ⇒ 整批被 catch 吞掉；修复后 MCP 豁免 ⇒ 全部在册。
  assert.doesNotThrow(() => registerToolsIfAbsent(strict, mcpDefs));
  assert.equal(strict.list().length, mcpDefs.length);
  for (const def of mcpDefs) {
    assert.equal(strict.has(def.name), true, `${def.name} 应注册成功`);
  }

  // 负控制：豁免是按 kind 精确豁免，而非整体关闭严格位——
  // 同一严格表注册「非 MCP」无 schema 工具仍 fail-loud（去掉 kind 豁免本断言即变红）。
  assert.throws(
    () => strict.register(toolWithoutOutputSchema("non_mcp_tool", "custom")),
    /vacuous canonical outputSchema/,
  );
});

test("专利域工具全部声明非空 outputSchema（R-05 验收）", () => {
  const registry = createBuiltinRegistry({});
  const patentTools = registry.list().filter(tool => tool.domain === "patent");
  assert.ok(patentTools.length >= 26, `expected >=26 patent tools, got ${patentTools.length}`);
  const empty = patentTools.filter(tool => {
    const properties = tool.outputSchema?.properties;
    return (
      tool.outputSchema === undefined ||
      typeof properties !== "object" ||
      properties === null ||
      Object.keys(properties).length === 0
    );
  });
  assert.deepEqual(
    empty.map(tool => tool.name),
    [],
  );
});

test("patent_workflow 只读声明与写副作用一致（R-05 验收）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("patent_workflow");
  assert.ok(tool);
  assert.equal(tool.isReadOnly({ manifestId: "patent_novelty_v1" }), true);
  assert.equal(tool.isReadOnly({ manifestId: "patent_novelty_v1", caseId: "case-1" }), false);
});

test("R-06 编排收敛：8/8 内置 manifest 至少出现在一个工具描述中", () => {
  const registry = createBuiltinRegistry({});
  const descriptions = registry
    .list()
    .filter(tool => tool.domain === "patent")
    .map(tool => tool.description)
    .join("\n");
  for (const { manifest } of builtinPatentManifests) {
    assert.ok(descriptions.includes(manifest.id), `manifest ${manifest.id} not discoverable in tool descriptions`);
  }
  assert.equal(builtinPatentManifests.length, 8);
});

test("R-06 编排收敛：旧工具名保留为可调用别名", () => {
  const registry = createBuiltinRegistry({});
  assert.equal(registry.get("patent_workflow")?.name, "patent_workflow_assemble");
  assert.equal(registry.get("patent_workflow_assemble")?.name, "patent_workflow_assemble");
  assert.equal(registry.get("patent_plan_task")?.name, "flexible_plan");
  assert.equal(registry.get("flexible_plan")?.name, "flexible_plan");
});

test("R-06 描述预算：单工具 <=1200 字符、属性描述 <=200 字符、专利面总契约 <=40k", () => {
  const registry = createBuiltinRegistry({});
  const patentTools = registry.list().filter(tool => tool.domain === "patent");
  let total = 0;
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.description === "string") {
      assert.ok(record.description.length <= 200, `${path}.description is ${record.description.length} chars`);
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`);
  };
  for (const tool of patentTools) {
    assert.ok(tool.description.length <= 1200, `${tool.name} description is ${tool.description.length} chars`);
    walk(tool.inputSchema, tool.name);
    total += tool.description.length + JSON.stringify(tool.inputSchema).length;
  }
  assert.ok(total <= 40_000, `patent contract is ${total} chars (budget 40000)`);
});

test("R-06 编排收敛：patent_plan_task 旧动作经 flexible_plan 别名仍可执行", async () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("patent_plan_task");
  assert.ok(tool);
  const result = await tool.execute({ action: "sync", planSteps: ["检索现有技术", "比对技术特征"] }, {
    env: {},
    cwd: "/",
    projectRoot: "/",
    abortSignal: undefined,
  } as never);
  const data = result.data as { action: string; tasks: unknown[]; toRun: string[] };
  assert.equal(data.action, "sync");
  assert.equal(data.tasks.length, 2);
  assert.deepEqual(data.toRun, ["task-1", "task-2"]);
});
