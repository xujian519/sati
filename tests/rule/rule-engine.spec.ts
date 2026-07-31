import assert from "node:assert/strict";
import test from "node:test";
import { evaluateText, groupByAction, type ConstitutionalRule, type RuleSet } from "../../src/rule/index.js";

function ruleSet(rules: ConstitutionalRule[]): RuleSet {
  return { rules };
}

test("keyword_blocklist flags matching keywords", () => {
  const set = ruleSet([
    {
      id: "CON-102",
      name: "违法排除",
      severity: "critical",
      action: "block",
      check: { type: "keyword_blocklist", keywords: ["赌博|博彩", "毒品"] },
    },
  ]);
  const result = evaluateText("该装置用于赌博检测。", set);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.ruleId, "CON-102");
  assert.ok(result.violations[0]?.evidence.includes("赌博"));
});

test("keyword_blocklist negation_context allows negated mentions", () => {
  const set = ruleSet([
    {
      id: "CON-102",
      name: "违法排除",
      severity: "critical",
      action: "block",
      check: { type: "keyword_blocklist", keywords: ["赌博|博彩"], negationContext: true },
    },
  ]);
  assert.equal(evaluateText("本发明用于防止赌博成瘾。", set).violations.length, 0);
  assert.equal(evaluateText("本发明用于赌博检测。", set).violations.length, 1);
});

test("keyword_blocklist without negation_context still flags negated mentions", () => {
  const set = ruleSet([
    {
      id: "CON-102",
      name: "违法排除",
      severity: "critical",
      action: "block",
      check: { type: "keyword_blocklist", keywords: ["赌博"] },
    },
  ]);
  assert.equal(evaluateText("本发明用于防止赌博。", set).violations.length, 1);
});

test("pattern_analysis flags matching regex with minMatches", () => {
  const set = ruleSet([
    {
      id: "CON-201",
      name: "禁止引用式权利要求",
      severity: "major",
      action: "warn",
      check: { type: "pattern_analysis", patterns: ["如权利要求\\d+所述"], minMatches: 1 },
    },
  ]);
  const result = evaluateText("该方案如权利要求2所述。", set);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.action, "warn");
});

test("pattern_analysis respects minMatches threshold", () => {
  const set = ruleSet([
    {
      id: "CON-202",
      name: "双模式",
      severity: "minor",
      action: "log",
      check: { type: "pattern_analysis", patterns: ["实施例"], minMatches: 2 },
    },
  ]);
  // 命中 1 次 < minMatches 2 → 不违规
  assert.equal(evaluateText("仅一个实施例。", set).violations.length, 0);
  // 命中 2 次 >= minMatches 2 → 违规
  assert.equal(evaluateText("实施例一与实施例二。", set).violations.length, 1);
});

test("structural_analysis flags missing elements below minConfidence", () => {
  const set = ruleSet([
    {
      id: "CON-101",
      name: "技术方案三要素",
      severity: "critical",
      action: "block",
      check: {
        type: "structural_analysis",
        requiresAll: [
          { element: "technical_means", patterns: ["装置|设备|系统|模块"] },
          { element: "technical_problem", patterns: ["问题|不足|缺陷"] },
          { element: "technical_effect", patterns: ["提高|改善|增强|优化"] },
        ],
        minConfidence: 0.66,
      },
    },
  ]);
  // 命中 2/3 要素（0.67 >= 0.66）→ 通过
  const pass = evaluateText("本装置解决现有技术问题，提高了效率。", set);
  assert.equal(pass.violations.length, 0);
  // 命中 1/3（0.33 < 0.66）→ 违规
  const fail = evaluateText("一种模块化设计。", set);
  assert.equal(fail.violations.length, 1);
  assert.match(fail.violations[0]?.message ?? "", /缺失/);
});

test("citation_analysis flags out-of-range article numbers (R1)", () => {
  const set = ruleSet([
    {
      id: "CON-301",
      name: "法条范围",
      severity: "major",
      action: "warn",
      check: { type: "citation_analysis", statutes: { 专利法: { max: 78 } } },
    },
  ]);
  assert.equal(evaluateText("依据专利法第22条。", set).violations.length, 0);
  const result = evaluateText("依据专利法第99条。", set);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]?.message ?? "", /超出范围/);
});

test("groupByAction buckets violations by action", () => {
  const set = ruleSet([
    {
      id: "R1",
      name: "block 规则",
      severity: "critical",
      action: "block",
      check: { type: "keyword_blocklist", keywords: ["炸弹"] },
    },
    {
      id: "R2",
      name: "review 规则",
      severity: "major",
      action: "review",
      check: { type: "keyword_blocklist", keywords: ["专利结论"] },
    },
    {
      id: "R3",
      name: "warn 规则",
      severity: "minor",
      action: "warn",
      check: { type: "keyword_blocklist", keywords: ["绝对"] },
    },
  ]);
  const grouped = groupByAction(evaluateText("本结论涉及炸弹与专利结论，绝对可靠。", set));
  assert.equal(grouped.block?.length, 1);
  assert.equal(grouped.review?.length, 1);
  assert.equal(grouped.warn?.length, 1);
});
