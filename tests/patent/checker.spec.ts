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
  specRules,
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

test("matchKeyword: 扩充否定词表不误报（缺乏/没有/未给出/未记载）", () => {
  // 扩充前这些表述会被当"肯定提及"→ 规则门漏报
  assert.equal(matchKeyword("缺乏创造性", "创造性"), false);
  assert.equal(matchKeyword("没有新颖性", "新颖性"), false);
  assert.equal(matchKeyword("无法体现创造性", "创造性"), false);
  assert.equal(matchKeyword("未给出技术启示", "技术启示"), false);
  assert.equal(matchKeyword("说明书未记载技术效果", "技术效果"), false);
  assert.equal(matchKeyword("难以认定具有创造性", "创造性"), false);
  // 肯定表述仍正常命中（不误伤）
  assert.equal(matchKeyword("本申请具备新颖性", "新颖性"), true);
  assert.equal(matchKeyword("对比文件未公开该特征，因此具备新颖性", "新颖性"), true);
});

test("matchKeyword: 双重否定不误判（并非没有/并不缺乏 = 肯定语义）", () => {
  // 窗口含命中词后，嵌目标词的否定模式会命中"并非没有新颖性"——
  // 反否定前缀守卫应将其翻转为肯定（典型紧邻形式）
  assert.equal(matchKeyword("本发明并非没有新颖性", "新颖性"), true);
  assert.equal(matchKeyword("本申请并不缺乏创造性", "创造性"), true);
  assert.equal(matchKeyword("该方案并非没有技术启示", "技术启示"), true);
  // 单纯否定仍判否定（守卫不误放行）
  assert.equal(matchKeyword("本申请没有新颖性", "新颖性"), false);
  assert.equal(matchKeyword("该方案缺乏技术启示", "技术启示"), false);
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

test("reasoningPatternRules: 4 组条数 = 7/6/5/6 且 id 唯一", () => {
  const rs = reasoningPatternRules();
  const byGroup = (prefix: string) => rs.filter(r => r.id.startsWith(prefix)).length;
  assert.equal(byGroup("REASON-CREATIVITY-"), 7, "创造性组应为 7 条");
  assert.equal(byGroup("REASON-NOVELTY-"), 6, "新颖性组应为 6 条");
  assert.equal(byGroup("REASON-CLAIMS-"), 5, "权利要求/说明书组应为 5 条");
  assert.equal(byGroup("REASON-OTHER-"), 6, "其他组应为 6 条");
  assert.equal(
    new Set(rs.map(r => r.id)).size,
    rs.length,
    "规则 id 必须唯一（RuleEngine 以 id 建 Map，重复会静默覆盖）",
  );
});

test("推理模式: pathElements 为 string[][] 层级（每步至少命中其一）", () => {
  const rs = reasoningPatternRules();
  const sample = rs.find(r => r.id === "REASON-CREATIVITY-01A");
  assert.ok(sample, "REASON-CREATIVITY-01A 应存在");
  const steps = sample.pathElements;
  assert.ok(Array.isArray(steps), "REASON-CREATIVITY-01A 应声明 pathElements");
  if (!steps) return;
  for (const step of steps) {
    assert.ok(Array.isArray(step) && step.length >= 1, `路径步骤 ${JSON.stringify(step)} 应为非空数组`);
  }
  // 抽样其余三组各一条规则，校验嵌套层级
  for (const id of ["REASON-NOVELTY-01A", "REASON-CLAIMS-01", "REASON-OTHER-04"]) {
    const rule = rs.find(r => r.id === id);
    assert.ok(rule, `${id} 应存在`);
    if (rule.pathElements) {
      assert.ok(
        rule.pathElements.every(s => Array.isArray(s)),
        `${id} pathElements 应为 string[][]`,
      );
    }
  }
});

// =============================================================================
// 说明书域规则（patent_spec，spec-checklist 规则化）
// =============================================================================

test("spec: specRules 共 8 条并并入 defaultPatentRules", () => {
  assert.equal(specRules().length, 8);
  const all = defaultPatentRules();
  assert.ok(all.some(r => r.id === "SPEC-SECTIONS"));
  assert.ok(all.some(r => r.id === "SPEC-COMMERCIAL-BAN"));
  assert.ok(all.some(r => r.id === "SPEC-SCOPE-COMPLIANCE"));
});

test("spec: 说明书缺少章节 → 阻断", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const failures = local.evaluate("# 技术领域\n本发明涉及机械技术领域。", { domain: "patent_spec" });
  const sections = failures.find(f => f.ruleId === "SPEC-SECTIONS");
  assert.ok(sections, "应产出结构完整性规则失败");
  assert.equal(sections!.level, 1);
});

test("spec: 七部分齐全 + 三段式 + 实施例 + 摘要关键词 → 通过", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const text = [
    "# 技术领域",
    "本发明涉及机械技术领域。",
    "# 背景技术",
    "现有技术存在效率低下的问题。",
    "# 发明内容",
    "本发明要解决的技术问题是提高分拣效率。本发明提供如下技术方案：包括壳体与驱动单元。本发明的有益效果是效率提升30%。",
    "# 附图说明",
    "图1为本发明实施例的整体结构示意图。附图标记：1-壳体；2-驱动单元。",
    "# 具体实施方式",
    "实施例1：驱动单元采用伺服电机，转速为1000rpm。",
    "# 摘要",
    "本发明公开了一种分拣装置。关键词：分拣；驱动。",
  ].join("\n");
  const failures = local.evaluate(text, { domain: "patent_spec" });
  assert.deepEqual(failures, []);
});

test("spec: 商业宣传禁语 → 阻断", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const failures = local.evaluate("本方案行业领先，效率突出。", { domain: "patent_spec" });
  const ban = failures.find(f => f.ruleId === "SPEC-COMMERCIAL-BAN");
  assert.ok(ban, "应产出商业宣传禁语规则失败");
  assert.match(ban!.message, /行业领先/);
});

test("spec: 超范围表述 → 阻断", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const failures = local.evaluate("该特征超出原申请记载范围，需补充说明。", { domain: "patent_spec" });
  assert.ok(failures.some(f => f.ruleId === "SPEC-SCOPE-COMPLIANCE"));
});

test("spec: 否定语境（未超出原申请）不误报超范围", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const failures = local.evaluate("说明书内容未超出原申请记载范围，符合专利法第33条。", {
    domain: "patent_spec",
  });
  assert.ok(!failures.some(f => f.ruleId === "SPEC-SCOPE-COMPLIANCE"));
});

test("spec: 无摘要说明书不被 SPEC-SECTIONS 阻断（摘要为 Quality 级检查）", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const text = [
    "# 技术领域",
    "本发明涉及机械技术领域。",
    "# 背景技术",
    "现有技术存在效率低下的问题。",
    "# 发明内容",
    "本发明要解决的技术问题是提高效率。本发明提供如下技术方案：包括驱动单元。本发明的有益效果是效率提升30%。",
    "# 附图说明",
    "图1为本发明实施例的整体结构示意图。附图标记：1-驱动单元。",
    "# 具体实施方式",
    "实施例1：驱动单元采用伺服电机。",
  ].join("\n");
  const failures = local.evaluate(text, { domain: "patent_spec" });
  assert.ok(!failures.some(f => f.ruleId === "SPEC-SECTIONS"), "五部分齐全时 SPEC-SECTIONS 应通过");
  // 摘要缺失只触发 Quality 级 SPEC-ABSTRACT（不阻断）
  assert.ok(failures.some(f => f.ruleId === "SPEC-ABSTRACT"));
});

test("spec: 双重否定（不仅超出）不误判为否定语境", () => {
  const local = new RuleEngine();
  local.registerMany(specRules());
  const failures = local.evaluate("该修改不仅超出原申请记载范围，且引入新内容。", { domain: "patent_spec" });
  assert.ok(
    failures.some(f => f.ruleId === "SPEC-SCOPE-COMPLIANCE"),
    "不仅超出=肯定语义，应报超范围",
  );
});

// =============================================================================
// 规则总数与禁语扩充（防止注释失真/禁语漏网）
// =============================================================================

test("defaultPatentRules: 总条数 = 71（core 47 + reasoning 24）", () => {
  const all = defaultPatentRules();
  assert.equal(all.length, 71, `defaultPatentRules 实际 ${all.length} 条，应与注释同步`);
  // 每 3 条规则中约 1 条 Quality 级（粗粒度结构校验：各级别均非空）
  assert.ok(
    all.some(r => r.level === 0),
    "应含 Must 级规则",
  );
  assert.ok(
    all.some(r => r.level === 1),
    "应含 Should 级规则",
  );
  assert.ok(
    all.some(r => r.level === 2),
    "应含 Quality 级规则",
  );
  // 规则 id 唯一（注册表按 id 覆盖，重复 id 会静默丢规则）
  const ids = new Set(all.map(r => r.id));
  assert.equal(ids.size, all.length, "规则 id 应唯一");
});

test("novelty: 单独对比禁语扩充（对比文件1和2结合）→ 阻断", () => {
  // 扩充前 "对比文件1和2结合" 不在禁语表，可绕过 NOVELTY-SINGLE-COMPARISON
  const text = "将对比文件1和2结合，可认定本申请不具备新颖性。";
  const failures = engine.evaluate(text, { rules: noveltyRules() });
  const single = failures.find(f => f.ruleId === "NOVELTY-SINGLE-COMPARISON");
  assert.ok(single, "多文件结合书写形式应触发单独对比规则");
  assert.match(single!.message, /单独对比原则/);
});
