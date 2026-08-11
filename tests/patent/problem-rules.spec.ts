import assert from "node:assert/strict";
import test from "node:test";
import {
  RuleEngine,
  aggregate,
  defaultPatentRules,
  inventivenessRules,
  type RuleCheckResult,
} from "../../src/patent/checker/index.js";

const engine = new RuleEngine();
engine.registerMany(inventivenessRules());

/** 过滤出原子化 INV 规则失败项（INVENTIVENESS-PROBLEM-* 前缀）。 */
function atomicFailures(failures: readonly RuleCheckResult[]): RuleCheckResult[] {
  return failures.filter(f => f.ruleId.startsWith("INVENTIVENESS-PROBLEM-"));
}

/** 构造一段含指定"实际解决的技术问题"的创造性分析文本（三步法关键词齐全）。 */
function analysisText(problem: string): string {
  return (
    "创造性分析：最接近的现有技术为D1；区别技术特征为X；" + `实际解决的技术问题为：${problem}；` + "技术启示判断：无。"
  );
}

// =============================================================================
// INV07 技术问题不得包含解决手段（Must → blocked）
// =============================================================================

test("INV07: 技术问题包含解决手段 → 阻断", () => {
  const failures = engine.evaluate(analysisText("通过设置限位凸台防止位移"), { rules: inventivenessRules() });
  const binding = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-SOLUTION-BINDING");
  assert.ok(binding, "应产出技术问题含手段规则失败");
  assert.equal(binding!.level, 0);
  assert.match(binding!.message, /解决手段/);
  assert.equal(aggregate(failures), "blocked");
});

test("INV07: 合规技术问题（不含手段）→ 不触发", () => {
  const failures = engine.evaluate(analysisText("如何在部件装配后提供可靠的轴向定位"), {
    rules: inventivenessRules(),
  });
  const binding = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-SOLUTION-BINDING");
  assert.equal(binding, undefined, "合规技术问题不应命中绑方案规则");
});

// =============================================================================
// INV08 技术问题单一因果（Should → blocked）
// =============================================================================

test("INV08: 技术问题复合因果 → 阻断", () => {
  const failures = engine.evaluate(analysisText("温度过高导致芯片损坏，使得整机宕机"), {
    rules: inventivenessRules(),
  });
  const multi = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-MULTI-CAUSAL");
  assert.ok(multi, "应产出复合因果规则失败");
  assert.equal(multi!.level, 1);
  assert.match(multi!.message, /因果/);
  assert.equal(aggregate(failures), "blocked");
});

// =============================================================================
// INV09 技术问题可测效果（Quality → 累计，单条不阻断）
// =============================================================================

test("INV09: 技术问题缺少可测指标 → 质量提示（单条不阻断）", () => {
  const failures = engine.evaluate(analysisText("提高可靠性"), { rules: inventivenessRules() });
  const unmeasured = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-UNMEASURED");
  assert.ok(unmeasured, "应产出可测效果规则失败");
  assert.equal(unmeasured!.level, 2);
  assert.equal(aggregate(failures), "pass"); // 单条 Quality 不足 3 条 → pass
});

// =============================================================================
// 提取不到即放行（与现有 INVENTIVENESS-THREE-STEP 分工，不双重惩罚）
// =============================================================================

test("INV: 文本无'实际解决的技术问题'表述 → 三条均放行", () => {
  // 复用现有 checker.spec.ts 的 inventiveness 通过用例文本。
  const text =
    "创造性分析（三步法）：首先确定最接近的现有技术为D1；" +
    "其次，权利要求1相对于D1的区别技术特征为X；" +
    "最后，D2给出了将X应用于D1的技术启示，故不具备创造性。";
  const failures = engine.evaluate(text, { rules: inventivenessRules() });
  assert.deepEqual(atomicFailures(failures), []);
});

// =============================================================================
// Graph 形态（collectStateText 拼入的 inventiveness_diff JSON）
// =============================================================================

test("INV: Graph 形态（actual_technical_problem JSON 字段）→ 同样命中", () => {
  const text =
    '## inventiveness_parse\n{"features":["液冷管路"],"field":"散热"}\n' +
    "## inventiveness_diff\n" +
    '{"distinguishing_features":["液冷管路布局"],"actual_technical_problem":"通过设置限位凸台防止位移","effect_of_diff":"可靠定位"}';
  const failures = engine.evaluate(text, { rules: inventivenessRules() });
  const binding = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-SOLUTION-BINDING");
  assert.ok(binding, "Graph JSON 形态应命中技术问题含手段规则");
});

test('INV: JSON 转义引号（\\"）→ 正确还原并命中', () => {
  const text = "## inventiveness_diff\n" + '{"actual_technical_problem":"通过设置\\"限位凸台\\"防止位移"}';
  const failures = engine.evaluate(text, { rules: inventivenessRules() });
  const binding = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-SOLUTION-BINDING");
  assert.ok(binding, "转义引号不应影响技术问题提取");
});

// =============================================================================
// 协同与回归
// =============================================================================

test("INV: 合法技术问题 → 阻断级规则不触发，质量级提示触发", () => {
  const failures = engine.evaluate(analysisText("如何在部件装配后提供可靠的轴向定位"), {
    rules: inventivenessRules(),
  });
  const binding = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-SOLUTION-BINDING");
  const multi = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-MULTI-CAUSAL");
  assert.equal(binding, undefined, "合法技术问题不应命中绑方案规则");
  assert.equal(multi, undefined, "合法技术问题不应命中复合因果规则");
  const unmeasured = failures.find(f => f.ruleId === "INVENTIVENESS-PROBLEM-UNMEASURED");
  assert.ok(unmeasured, "缺可测指标应触发质量提示（不阻断）");
});

test("INV: defaultPatentRules 全量评估（现有三步法文本）→ 不新增原子化失败", () => {
  const local = new RuleEngine();
  local.registerMany(defaultPatentRules());
  const text =
    "创造性分析（三步法）：首先确定最接近的现有技术为D1；" +
    "其次，权利要求1相对于D1的区别技术特征为X；" +
    "最后，D2给出了将X应用于D1的技术启示，故不具备创造性。";
  const failures = local.evaluate(text, { domain: "patent_inventiveness" });
  assert.deepEqual(atomicFailures(failures), []);
});
