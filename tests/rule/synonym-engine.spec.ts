import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSynonymRequirements,
  evaluateText,
  hasNegationContext,
  loadSynonymsAsset,
  matchKeyword,
  parseRuleSetFromYaml,
  parseSynonyms,
} from "../../src/rule/index.js";

// ---------------------------------------------------------------------------
// 同义词表解析
// ---------------------------------------------------------------------------

test("parseSynonyms：解析 YAML 同义词表", () => {
  const { synonyms, warnings } = parseSynonyms(
    `
synonyms:
  新颖性:
    - 新创性
    - 未公开
  创造性:
    - 非显而易见
`,
  );
  assert.equal(warnings.length, 0);
  assert.deepEqual(synonyms.get("新颖性"), ["新创性", "未公开"]);
  assert.deepEqual(synonyms.get("创造性"), ["非显而易见"]);
});

test("parseSynonyms：坏条目跳过并告警", () => {
  const { synonyms, warnings } = parseSynonyms(
    `
synonyms:
  新颖性: 不是数组
  创造性:
    - 非显而易见
`,
  );
  assert.equal(synonyms.size, 1);
  assert.ok(warnings.length > 0);
});

test("loadSynonymsAsset：从仓库资产加载（50 组同义词）", () => {
  const { synonyms, source, warnings } = loadSynonymsAsset();
  assert.ok(source !== null, `资产未找到: ${warnings.join(";")}`);
  assert.ok(synonyms.size >= 40, `期望 ≥40 组同义词，实际 ${synonyms.size}`);
  assert.ok(synonyms.has("新颖性"));
  assert.ok(synonyms.has("单独对比"));
});

// ---------------------------------------------------------------------------
// matchKeyword：同义词展开 + 否定豁免
// ---------------------------------------------------------------------------

test("matchKeyword：同义词命中", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  新颖性:\n    - 新创性\n");
  assert.equal(matchKeyword("本方案具有新创性", "新颖性", synonyms), "新创性");
  assert.equal(matchKeyword("本方案具有新颖性", "新颖性", synonyms), "新颖性");
});

test("matchKeyword：否定语境豁免（不具有）", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  新颖性:\n    - 新创性\n");
  assert.equal(matchKeyword("本方案不具有新颖性", "新颖性", synonyms), null);
  assert.equal(matchKeyword("本方案不符合创造性要求", "创造性", synonyms), null);
});

test("matchKeyword：不具备（最常见 OA 句式）豁免", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  创造性:\n    - 非显而易见\n");
  assert.equal(matchKeyword("权利要求1不具备创造性", "创造性", synonyms), null);
  assert.equal(matchKeyword("权利要求1未具备创造性", "创造性", synonyms), null);
});

test("matchKeyword：首个命中否定不阻断后续肯定出现", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  新颖性:\n    - 新创性\n");
  // 首个"新颖性"在不具有后，后续"具备新颖性"为肯定 → 应命中
  assert.equal(matchKeyword("本申请不具有新颖性；但审查意见承认其具备新颖性", "新颖性", synonyms), "新颖性");
});

test("matchKeyword：同义词表 key 大小写不敏感（拉丁词）", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  inventive step:\n    - 创造性步骤\n");
  assert.equal(matchKeyword("该方案具有创造性步骤", "inventive step", synonyms), "创造性步骤");
});

test("hasNegationContext：否定模式与句界分隔", () => {
  // 窗口内出现否定短语且无句界 → 否定（matchStart 为"新颖性"起始位置）
  assert.equal(hasNegationContext("该方案无法证明新颖性", 7), true);
  assert.equal(hasNegationContext("本方案不具有新颖性", 6), true);
  assert.equal(hasNegationContext("该方案没有公开其结构。新颖性另述", 11), false); // 句界分隔
  // 窗口 60 字符外的不算
  const far = "未发现".padEnd(80, "字") + "新颖性";
  assert.equal(hasNegationContext(far, far.length - 3), false);
});

// ---------------------------------------------------------------------------
// checkSynonymRequirements：要素完整性
// ---------------------------------------------------------------------------

test("checkSynonymRequirements：全部要素命中（含同义词）", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  单独对比:\n    - 一一对比\n  三步法:\n    - 最接近的现有技术\n");
  const result = checkSynonymRequirements(
    "本案采用一一对比原则，从最接近的现有技术出发分析创造性",
    [
      { element: "single_comparison", keywords: ["单独对比"] },
      { element: "three_step", keywords: ["三步法"] },
    ],
    synonyms,
  );
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.missing, []);
});

test("checkSynonymRequirements：缺失要素报告", () => {
  const { synonyms } = parseSynonyms("synonyms:\n  单独对比:\n    - 一一对比\n  三步法:\n    - 最接近的现有技术\n");
  const result = checkSynonymRequirements(
    "本案仅对单个文件进行了比对",
    [{ element: "single_comparison", keywords: ["单独对比"] }],
    synonyms,
  );
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.missing, ["single_comparison"]);
});

// ---------------------------------------------------------------------------
// synonym_match 检查类型接入规则引擎
// ---------------------------------------------------------------------------

test("evaluateText：synonym_match 规则 — 缺失要素违规", () => {
  const { ruleSet } = parseRuleSetFromYaml(
    `
rules:
  - id: SYN-001
    name: 三步法完整性检查
    domain: patent
    severity: major
    action: warn
    check:
      type: synonym_match
      minConfidence: 1
      requirements:
        - element: closest_prior_art
          keywords: [三步法, 最接近的现有技术]
        - element: distinguishing_features
          keywords: [区别技术特征]
`,
  );
  const { synonyms } = parseSynonyms("synonyms:\n  三步法:\n    - 最接近的现有技术\n  区别技术特征:\n    - 区别特征\n");
  // 完整文本 → 无违规
  const ok = evaluateText("从最接近的现有技术出发，确定区别技术特征", ruleSet, synonyms);
  assert.equal(ok.violations.length, 0);

  // 缺第二步（"缺少"为否定模式，区别技术特征未命中）→ 违规
  const bad = evaluateText("仅分析了最接近的现有技术，缺少区别技术特征", ruleSet, synonyms);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0]!.ruleId, "SYN-001");
  assert.match(bad.violations[0]!.message, /缺失 distinguishing_features/);
});

test("evaluateText：synonym_match 否定豁免 — 否定表述不算命中", () => {
  const { ruleSet } = parseRuleSetFromYaml(
    `
rules:
  - id: SYN-002
    name: 新颖性要素检查
    domain: patent
    severity: major
    action: warn
    check:
      type: synonym_match
      minConfidence: 1
      requirements:
        - element: novelty
          keywords: [新颖性]
`,
  );
  const { synonyms } = parseSynonyms("synonyms:\n  新颖性:\n    - 新创性\n");
  const negated = evaluateText("本方案不具有新颖性", ruleSet, synonyms);
  assert.equal(negated.violations.length, 1);
});

test("evaluateText：无同义词表时降级为纯关键词匹配", () => {
  const { ruleSet } = parseRuleSetFromYaml(
    `
rules:
  - id: SYN-003
    name: 同义词检查
    domain: patent
    severity: minor
    action: warn
    check:
      type: synonym_match
      minConfidence: 1
      requirements:
        - element: novelty
          keywords: [新颖性]
`,
  );
  // 文本只用同义词"新创性"，无表注入 → 缺失违规（降级行为）
  const result = evaluateText("本方案具有新创性", ruleSet);
  assert.equal(result.violations.length, 1);
});

test("RuleLoader：synonym_match 非法 requirements 被拦截", () => {
  const { issues } = parseRuleSetFromYaml(
    `
rules:
  - id: SYN-BAD
    name: 坏规则
    domain: patent
    severity: minor
    action: warn
    check:
      type: synonym_match
      requirements: 不是数组
`,
  );
  assert.ok(issues.some(i => i.message.includes("synonym_match 需要非空 requirements")));
});
