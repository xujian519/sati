import assert from "node:assert/strict";
import test from "node:test";
import {
  RuleEngine,
  aggregate,
  defaultPatentRules,
  formatRuleResults,
  infringementRules,
  inventivenessRules,
  matchKeyword,
  noveltyRules,
  reasoningPatternRules,
  type RuleCheckResult,
  type Verdict,
} from "../../src/patent/checker/index.js";

// =============================================================================
// 判级模型（Aggregate）
// =============================================================================

function failure(level: 0 | 1 | 2, passed = false): RuleCheckResult {
  return {
    ruleId: `test-rule-${level}`,
    ruleName: `测试规则${level}`,
    passed,
    level,
    severity: level === 0 ? "critical" : level === 1 ? "major" : "minor",
    message: "测试失败",
    fixSuggestion: "测试建议",
  };
}

test("aggregate: 空结果 → pass", () => {
  assert.equal(aggregate([]), "pass");
});

test("aggregate: Level-0 (Must) 失败 → blocked", () => {
  assert.equal(aggregate([failure(0)]), "blocked");
});

test("aggregate: Level-1 (Should) 失败 → blocked", () => {
  assert.equal(aggregate([failure(1)]), "blocked");
});

test("aggregate: 1-2 条 Level-2 失败 → pass（质量小问题可容忍）", () => {
  assert.equal(aggregate([failure(2)]), "pass");
  assert.equal(aggregate([failure(2), failure(2)]), "pass");
});

test("aggregate: 3 条及以上 Level-2 失败 → needs_revision", () => {
  assert.equal(aggregate([failure(2), failure(2), failure(2)]), "needs_revision");
});

test("aggregate: passed 结果不参与判级", () => {
  assert.equal(aggregate([failure(2, true), failure(2, true)]), "pass");
});

// =============================================================================
// 新颖性规则（单独对比原则）
// =============================================================================

const engine = new RuleEngine();
engine.registerMany(defaultPatentRules());

test("novelty: 违反单独对比原则（多份文件结合）→ 阻断", () => {
  const text = "结合多份对比文件结合，可认定本申请不具备新颖性。";
  const failures = engine.evaluate(text, { rules: noveltyRules() });
  const single = failures.find(f => f.ruleId === "NOVELTY-SINGLE-COMPARISON");
  assert.ok(single, "应产出单独对比规则失败");
  assert.equal(single!.level, 0);
  assert.match(single!.message, /单独对比原则/);
});

test("novelty: 规范文本（单独对比+特征覆盖）→ 通过", () => {
  const text =
    "新颖性分析：将权利要求1与对比文件D1进行单独对比。" +
    "逐项比对技术特征，权利要求1的所有技术特征均已被D1公开，故不具备新颖性。";
  const failures = engine.evaluate(text, { rules: noveltyRules() });
  assert.deepEqual(failures, []);
});

// =============================================================================
// 创造性三步法
// =============================================================================

test("inventiveness: 缺三步法步骤 → 阻断", () => {
  const text = "创造性分析：本领域技术人员有动机结合，故不具备创造性。";
  const failures = engine.evaluate(text, { rules: inventivenessRules() });
  const threeStep = failures.find(f => f.ruleId === "INVENTIVENESS-THREE-STEP");
  assert.ok(threeStep, "应产出三步法规则失败");
  assert.equal(threeStep!.level, 0);
  assert.match(threeStep!.message, /三步法/);
});

test("inventiveness: 三步法齐全 → 通过", () => {
  const text =
    "创造性分析（三步法）：首先确定最接近的现有技术为D1；" +
    "其次，权利要求1相对于D1的区别技术特征为X；" +
    "最后，D2给出了将X应用于D1的技术启示，故不具备创造性。";
  const failures = engine.evaluate(text, { rules: inventivenessRules() });
  assert.deepEqual(failures, []);
});

// =============================================================================
// 侵权规则（全面覆盖）
// =============================================================================

test("infringement: 缺全面覆盖分析 → 阻断", () => {
  const text = "侵权分析：被控方案的技术特征与权利要求基本相同。";
  const failures = engine.evaluate(text, { rules: infringementRules() });
  const coverage = failures.find(f => f.ruleId === "INFRINGEMENT-FULL-COVERAGE");
  assert.ok(coverage, "应产出全面覆盖规则失败");
  assert.equal(coverage!.level, 0);
});

test("infringement: 全面覆盖+等同+禁止反悔 → 通过", () => {
  const text =
    "侵权分析：将被控方案与权利要求1的技术特征逐一比对（全面覆盖原则），" +
    "特征A构成等同替换；同时审查审查过程修改，不存在禁止反悔情形，亦不适用捐献规则。";
  const failures = engine.evaluate(text, { rules: infringementRules() });
  assert.deepEqual(failures, []);
});

// =============================================================================
// 同义词扩展与否定检测
// =============================================================================

test("matchKeyword: 同义词扩展命中（现有技术 → 对比文件）", () => {
  assert.equal(matchKeyword("检索到一篇现有技术文献", "对比文件"), true);
});

test("matchKeyword: 否定语境不误报（未发现区别特征）", () => {
  assert.equal(matchKeyword("未发现区别技术特征", "区别技术特征"), false);
});

test("matchKeyword: 直接命中返回 true", () => {
  assert.equal(matchKeyword("本申请具备新颖性", "新颖性"), true);
});

test("matchKeyword: 无关文本返回 false", () => {
  assert.equal(matchKeyword("今天的天气很好", "新颖性"), false);
});

// =============================================================================
// 域过滤
// =============================================================================

test("evaluate: 域过滤只评估匹配域的规则", () => {
  const text = "本申请具备新颖性。";
  const filtered = engine.evaluate(text, { domain: "patent_novelty" });
  const allRules = defaultPatentRules();
  // 过滤后只含 patent_novelty 域规则（PRIORITY/PUBACC 规则 domain 同为 patent_novelty，属 Mady 设计）
  for (const failure of filtered) {
    const rule = allRules.find(r => r.id === failure.ruleId);
    assert.equal(rule?.domain, "patent_novelty");
  }
  // 全量评估结果数 ≥ 域过滤结果数（其余域规则对同一文本也可能失败）
  const full = engine.evaluate(text);
  assert.ok(full.length >= filtered.length);
});

test("evaluate: 多域过滤（任一匹配即评估）", () => {
  const text = "本申请具备新颖性。";
  const multi = engine.evaluate(text, { domain: ["patent_novelty", "patent_disclosure"] });
  const allRules = defaultPatentRules();
  for (const failure of multi) {
    const rule = allRules.find(r => r.id === failure.ruleId);
    assert.ok(
      rule?.domain === "patent_novelty" || rule?.domain === "patent_disclosure",
      `规则 ${failure.ruleId} 域 ${rule?.domain} 不在过滤域内`,
    );
  }
  // 多域结果覆盖两个单域结果（并集）
  const single = engine.evaluate(text, { domain: "patent_novelty" });
  const singleDisclosure = engine.evaluate(text, { domain: "patent_disclosure" });
  assert.ok(multi.length >= single.length && multi.length >= singleDisclosure.length);
});

test("evaluate: 空串域 = 全部规则（向后兼容）", () => {
  const all = engine.evaluate("本申请具备新颖性。", { domain: "" });
  const none = engine.evaluate("本申请具备新颖性。");
  assert.equal(all.length, none.length);
});

// =============================================================================
// 注册/查询/移除与报告
// =============================================================================

test("RuleEngine: register/get/remove/all 生命周期", () => {
  const local = new RuleEngine();
  local.registerMany(noveltyRules());
  assert.equal(local.all().length, noveltyRules().length);
  const id = noveltyRules()[0]!.id;
  assert.ok(local.get(id));
  local.remove(id);
  assert.equal(local.get(id), undefined);
});

test("evaluate: 空文本触发全部失败，aggregate → blocked", () => {
  const failures = engine.evaluate("", { domain: "patent_infringement" });
  assert.ok(failures.length > 0);
  const verdict: Verdict = aggregate(failures);
  assert.equal(verdict, "blocked");
});

test("formatRuleResults: 通过时输出 Markdown 结论行", () => {
  const md = formatRuleResults([], "pass");
  assert.match(md, /检查结论: ✅ 通过/);
  assert.match(md, /所有规则检查均通过/);
});

test("formatRuleResults: 失败时输出表格行", () => {
  const md = formatRuleResults(engine.evaluate("", { domain: "patent_novelty" }), "blocked");
  assert.match(md, /检查结论: ⛔ 阻断/);
  assert.match(md, /\| 规则 \| 级别 \| 严重度 \| 问题 \| 修改建议 \|/);
});

// =============================================================================
// 推理模式规则（18 模式 × CheckRules = 24 条，PathElements 路径完整性）
// =============================================================================

test("reasoningPatternRules: 24 条且并入 defaultPatentRules", () => {
  assert.equal(reasoningPatternRules().length, 24);
  const all = defaultPatentRules();
  assert.ok(all.some(r => r.id === "REASON-CREATIVITY-01A"));
  assert.ok(all.some(r => r.id === "REASON-NOVELTY-01A"));
  assert.ok(all.some(r => r.id === "REASON-OTHER-04"));
});

test("推理模式: 公知常识路径完整 → 通过", () => {
  const local = new RuleEngine();
  local.registerMany(reasoningPatternRules());
  const text =
    "最接近的现有技术为D1，区别技术特征在于X，该区别特征属于本领域的公知常识/惯用技术手段，" +
    "本领域技术人员无需创造性劳动即可获得（显而易见），故不具备创造性。";
  const failures = local.evaluate(text, { domain: "patent_inventiveness" });
  assert.ok(!failures.some(f => f.ruleId === "REASON-CREATIVITY-01A"));
});

test("推理模式: 公知常识路径缺步骤 → 阻断并指出缺失步骤", () => {
  const local = new RuleEngine();
  local.registerMany(reasoningPatternRules());
  const text = "最接近的现有技术为D1，区别技术特征在于X，故不具备创造性。";
  const failures = local.evaluate(text, { domain: "patent_inventiveness" });
  const r = failures.find(f => f.ruleId === "REASON-CREATIVITY-01A");
  assert.ok(r, "应产出公知常识路径规则失败");
  assert.equal(r!.level, 0);
  assert.match(r!.message, /推理路径步骤3不完整/);
});

test("推理模式: 四相同标准路径（单独对比）→ 通过", () => {
  const local = new RuleEngine();
  local.registerMany(reasoningPatternRules());
  const text =
    "新颖性分析：现有技术D1，采用单独对比原则一一对比。技术领域相同、技术问题相同、" +
    "技术方案相同、技术效果相同，故不具备新颖性。";
  const failures = local.evaluate(text, { domain: "patent_novelty" });
  assert.ok(!failures.some(f => f.ruleId === "REASON-NOVELTY-01A"));
});

test("推理模式: 四相同标准缺步骤 → 阻断", () => {
  const local = new RuleEngine();
  local.registerMany(reasoningPatternRules());
  const failures = local.evaluate("该申请具备新颖性。", { domain: "patent_novelty" });
  const r = failures.find(f => f.ruleId === "REASON-NOVELTY-01A");
  assert.ok(r, "应产出四相同标准规则失败");
  assert.equal(r!.level, 0);
});
