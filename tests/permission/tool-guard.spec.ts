import assert from "node:assert/strict";
import test from "node:test";
import {
  PermissionRuntime,
  ToolGuardRegistry,
  createDefaultPermissionContext,
  type PermissionRule,
  type ToolGuard,
} from "../../src/permission/index.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../src/tool/index.js";
import {
  EVIDENCE_COMPLIANCE_TOOL,
  evidenceComplianceGuards,
  evi011GuardConditionFields,
} from "../../src/patent/guard/evidenceComplianceGuards.js";

/**
 * 工具级单调 deny Guard 测试。
 *
 * 核心语义（对应 dsh monotonic guard）：
 * - Guard 只拒绝、不放行——任何 allow/ask 规则都不能覆盖 Guard 的拒绝；
 * - Guard 不触发 HITL（不产生 ask / permission_request）；
 * - Guard 异常按拒绝处理（fail-closed）；
 * - 多个 Guard 全部执行，收集全部拒绝（不短路）。
 */

function makeTool(
  name: string,
  opts?: { readOnly?: boolean; checkPermissions?: SatiToolDefinition["checkPermissions"] },
): SatiToolDefinition {
  return {
    name,
    description: "test tool",
    kind: "filesystem",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => opts?.readOnly ?? false,
    isConcurrencySafe: () => false,
    ...(opts?.checkPermissions ? { checkPermissions: opts.checkPermissions } : {}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function makeContext(
  overrides: Partial<Parameters<typeof createDefaultPermissionContext>[0]> = {},
): SatiToolRuntimeContext {
  const permissionContext = createDefaultPermissionContext({
    cwd: "/home/u/proj",
    canPrompt: true,
    ...overrides,
  });
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: permissionContext.cwd,
    permissionMode: permissionContext.mode,
    permissionContext,
  };
}

function rule(overrides: Partial<PermissionRule> & { toolName: string }): PermissionRule {
  return { source: "user", behavior: "allow", ...overrides };
}

/** 始终拒绝的 guard（注入后所有调用被拒）。 */
const alwaysDeny: ToolGuard = tool => ({ message: `拒绝 ${tool.name}` });

test("guard deny 优先于 user allow 规则（单调：不可被放行覆盖）", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(alwaysDeny);
  const runtime = new PermissionRuntime({ guards: registry });
  const tool = makeTool("read_file", { readOnly: true });
  const decision = await runtime.decide(
    tool,
    {},
    makeContext({ rules: { allow: [rule({ toolName: "read_file" })] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.equal(decision.reason.type, "safety");
    assert.match(decision.message, /拒绝 read_file/);
  }
});

test("guard deny 优先于 session allow 规则（已记住的放行也无法覆盖）", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(alwaysDeny);
  const runtime = new PermissionRuntime({ guards: registry });
  const tool = makeTool("write_file");
  const decision = await runtime.decide(
    tool,
    {},
    makeContext({ rules: { allow: [rule({ toolName: "write_file", source: "session" })] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.equal(decision.reason.type, "safety");
});

test("guard deny 优先于 ask 规则且不触发 HITL（不产生 permission_request）", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(alwaysDeny);
  const runtime = new PermissionRuntime({ guards: registry });
  const tool = makeTool("write_file");
  const decision = await runtime.decide(
    tool,
    {},
    makeContext({ rules: { ask: [rule({ toolName: "write_file", behavior: "ask" })] } }),
    "call-1",
  );
  assert.equal(decision.type, "deny", "guard 拒绝时不得降级为 ask");
  assert.notEqual(decision.type, "ask");
});

test("guard deny 优先于工具自身 checkPermissions 的 ask", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(alwaysDeny);
  const runtime = new PermissionRuntime({ guards: registry });
  const tool = makeTool("web_search", {
    checkPermissions: async () => ({
      type: "ask",
      reason: { type: "tool", toolName: "web_search", message: "ask" },
      request: {
        toolCallId: "call-1",
        toolName: "web_search",
        inputSummary: "{}",
        reason: { type: "tool", toolName: "web_search", message: "ask" },
        options: [
          { id: "allow_once", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
  });
  const decision = await runtime.decide(tool, {}, makeContext(), "call-1");
  assert.equal(decision.type, "deny");
});

test("多个 guard 全部执行：收集全部拒绝（不短路）", async () => {
  const registry = new ToolGuardRegistry();
  const seen: string[] = [];
  registry.register(_tool => {
    seen.push("g1");
    return { message: "拒绝一" };
  });
  registry.register(_tool => {
    seen.push("g2");
    return { message: "拒绝二" };
  });
  const runtime = new PermissionRuntime({ guards: registry });
  const decision = await runtime.decide(makeTool("write_file"), {}, makeContext(), "call-1");
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.match(decision.message, /拒绝一/);
    assert.match(decision.message, /拒绝二/);
  }
  assert.deepEqual(seen, ["g1", "g2"], "两个 guard 都必须执行");
});

test("guard 抛异常按拒绝处理（fail-closed）", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(() => {
    throw new Error("guard 内部故障");
  });
  const runtime = new PermissionRuntime({ guards: registry });
  const decision = await runtime.decide(makeTool("write_file"), {}, makeContext(), "call-1");
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.match(decision.message, /fail-closed/);
    assert.match(decision.message, /guard 内部故障/);
  }
});

test("guard 放行时走正常权限链（读工具直接 allow）", async () => {
  const registry = new ToolGuardRegistry();
  registry.register(() => undefined); // 放行
  const runtime = new PermissionRuntime({ guards: registry });
  const decision = await runtime.decide(makeTool("read_file", { readOnly: true }), {}, makeContext(), "call-1");
  assert.equal(decision.type, "allow");
  if (decision.type === "allow") assert.equal(decision.reason.type, "mode");
});

test("registry 支持 unregister（守卫可拆卸）", () => {
  const registry = new ToolGuardRegistry();
  const guard: ToolGuard = () => ({ message: "x" });
  registry.register(guard);
  assert.equal(registry.size, 1);
  assert.equal(registry.unregister(guard), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.unregister(guard), false);
});

// ---------------------------------------------------------------------------
// 首批合规 guard：域外/外文证据强制声明（evaluate_evidence）
// ---------------------------------------------------------------------------

const evidenceTool = makeTool(EVIDENCE_COMPLIANCE_TOOL, { readOnly: true });

function evidenceRuntime(): PermissionRuntime {
  const registry = new ToolGuardRegistry();
  for (const guard of evidenceComplianceGuards) registry.register(guard);
  return new PermissionRuntime({ guards: registry });
}

test("域外证据缺少公证/认证被拒绝（EVI-011）", async () => {
  const decision = await evidenceRuntime().decide(
    evidenceTool,
    { evidenceType: "overseas", notarized: true, legalized: false },
    makeContext(),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.match(decision.message, /公证|认证/);
});

test("域外证据声明公证+认证后放行", async () => {
  const decision = await evidenceRuntime().decide(
    evidenceTool,
    { evidenceType: "overseas", notarized: true, legalized: true, translated: true },
    makeContext(),
    "call-1",
  );
  assert.equal(decision.type, "allow", "证据形式要件齐备时应放行");
});

test("外文证据缺少中文译本被拒绝（EVI-011）", async () => {
  const decision = await evidenceRuntime().decide(
    evidenceTool,
    { evidenceType: "foreign_language", translated: false },
    makeContext(),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") assert.match(decision.message, /译本/);
});

test("非证据工具不受证据合规 guard 影响", async () => {
  const decision = await evidenceRuntime().decide(
    makeTool("patent_search", { readOnly: true }),
    { query: "硅碳负极" },
    makeContext(),
    "call-1",
  );
  assert.equal(decision.type, "allow");
});

// 契约测试：guard 依赖字段与工具 inputSchema / 工具名保持同步（防静默失效）
// ---------------------------------------------------------------------------

test("契约：createEvaluateEvidenceTool 名称与 EVIDENCE_COMPLIANCE_TOOL 一致", async () => {
  const { createEvaluateEvidenceTool } = await import("../../src/tool/builtin/evaluateEvidence.js");
  const tool = createEvaluateEvidenceTool();
  assert.equal(tool.name, EVIDENCE_COMPLIANCE_TOOL, "工具改名必须同步 guard 常量");
});

test("契约：工具 inputSchema 覆盖 guard 依赖的全部字段", async () => {
  const { createEvaluateEvidenceTool } = await import("../../src/tool/builtin/evaluateEvidence.js");
  const schema = createEvaluateEvidenceTool().inputSchema;
  assert.equal(schema.type, "object");
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  // guard 依赖 evidenceType / notarized / legalized / translated。
  for (const field of ["evidenceType", "notarized", "legalized", "translated"]) {
    assert.ok(field in properties, `inputSchema 缺少 guard 依赖字段 ${field}`);
  }
  assert.equal(properties.notarized?.type, "boolean");
  assert.equal(properties.legalized?.type, "boolean");
  assert.equal(properties.translated?.type, "boolean");
});

// 契约测试：guard 的 EVI-011 条件字段必须 ⊆ evidence-rules.yaml 的 conditions
// ---------------------------------------------------------------------------

const EVI_011_FIELD_TO_CONDITION: Record<string, string> = {
  notarized: "evidence_notarized",
  legalized: "evidence_legalized",
  translated: "evidence_translated",
};

test("契约：guard 的 EVI-011 条件 ⊆ YAML 的 EVI-011 conditions", async () => {
  const { loadEvidenceRulesEngine } = await import("../../src/patent/evidence/rule-loader.js");
  const rule = loadEvidenceRulesEngine()
    .engine.getRules()
    .find(r => r.ruleId === "EVI-011");
  assert.ok(rule, "应能找到 EVI-011 规则资产（rules/patent/evidence-rules.yaml）");
  const yamlConditions = new Set(rule.check?.conditions ?? []);
  assert.ok(yamlConditions.size > 0, "EVI-011 规则应有 conditions");
  for (const field of evi011GuardConditionFields()) {
    const condition = EVI_011_FIELD_TO_CONDITION[field];
    assert.ok(condition !== undefined, `guard 字段 ${field} 应有 YAML 条件名映射`);
    assert.ok(yamlConditions.has(condition), `guard 条件 ${condition} 不在 YAML EVI-011 conditions 中`);
  }
});
