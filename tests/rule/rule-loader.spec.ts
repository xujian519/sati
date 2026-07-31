import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadRuleSetDir,
  loadRuleSetFromFile,
  mergeRuleSets,
  parseRuleSetFromYaml,
  validateRuleSet,
} from "../../src/rule/index.js";

const ARRAY_YAML = `
version: "1.0"
rules:
  - id: CON-101
    name: 发明定义-技术方案三要素
    domain: patent
    phase: 申请前
    severity: critical
    action: block
    legalBasis: 专利法第二条第二款
    check:
      type: structural_analysis
      requiresAll:
        - element: technical_means
          patterns: ["装置|设备|系统"]
        - element: technical_effect
          patterns: ["提高|改善"]
      minConfidence: 0.5
`;

const MAP_YAML = `
rules:
  subject_matter_excluded_art5:
    id: CON-102
    name: 违法排除
    severity: critical
    action: block
    check:
      type: keyword_blocklist
      keywords: ["赌博|博彩"]
      negationContext: true
`;

test("parseRuleSetFromYaml parses array form", () => {
  const { ruleSet, issues } = parseRuleSetFromYaml(ARRAY_YAML, "array.yaml");
  assert.equal(issues.length, 0);
  assert.equal(ruleSet.rules.length, 1);
  const rule = ruleSet.rules[0];
  assert.equal(rule?.id, "CON-101");
  assert.equal(rule?.domain, "patent");
  assert.equal(rule?.phase, "申请前");
  assert.equal(rule?.legalBasis, "专利法第二条第二款");
  assert.equal(rule?.check.type, "structural_analysis");
  if (rule?.check.type === "structural_analysis") {
    assert.equal(rule.check.requiresAll.length, 2);
    assert.equal(rule.check.minConfidence, 0.5);
  }
});

test("parseRuleSetFromYaml parses map form (BCIP style)", () => {
  const { ruleSet, issues } = parseRuleSetFromYaml(MAP_YAML, "map.yaml");
  assert.equal(issues.length, 0);
  assert.equal(ruleSet.rules.length, 1);
  const rule = ruleSet.rules[0];
  assert.equal(rule?.id, "CON-102");
  assert.equal(rule?.check.type, "keyword_blocklist");
  if (rule?.check.type === "keyword_blocklist") {
    assert.equal(rule.check.negationContext, true);
  }
});

test("parseRuleSetFromYaml reports invalid severity and missing id", () => {
  const { issues } = parseRuleSetFromYaml(
    `
rules:
  - id: CON-X
    name: bad
    severity: "fatal"
    action: block
    check: { type: keyword_blocklist, keywords: ["x"] }
  - name: no-id
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
  );
  assert.ok(issues.some(i => i.message.includes("severity")));
  assert.ok(issues.some(i => i.message.includes("缺少 id")));
});

test("parseRuleSetFromYaml rejects invalid regex in pattern_analysis", () => {
  const { issues } = parseRuleSetFromYaml(
    `
rules:
  - id: CON-P
    name: bad regex
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["("] }
`,
  );
  assert.ok(issues.some(i => i.message.includes("非法正则")));
});

test("parseRuleSetFromYaml rejects nested-quantifier regex (ReDoS guard)", () => {
  const { issues } = parseRuleSetFromYaml(
    `
rules:
  - id: CON-REDOS
    name: redos
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["(a+)+"] }
`,
  );
  assert.ok(issues.some(i => i.message.includes("灾难性回溯")));
});

test("parseRuleSetFromYaml reports duplicate ids", () => {
  const { issues } = parseRuleSetFromYaml(
    `
rules:
  - id: CON-DUP
    name: a
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"] }
  - id: CON-DUP
    name: b
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
  );
  assert.ok(issues.some(i => i.message.includes("重复的规则 id")));
});

test("loadRuleSetFromFile reads a valid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-test-"));
  const path = join(dir, "test.yaml");
  writeFileSync(path, ARRAY_YAML, "utf8");
  const loaded = loadRuleSetFromFile(path);
  assert.equal(loaded.ruleSet.rules.length, 1);
  assert.equal(loaded.warnings.length, 0);
});

test("loadRuleSetFromFile keeps valid rules when only a rule is missing id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-test-"));
  const path = join(dir, "mixed.yaml");
  writeFileSync(
    path,
    `
rules:
  - id: CON-OK
    name: good
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"] }
  - name: no-id
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
    "utf8",
  );
  const loaded = loadRuleSetFromFile(path);
  assert.equal(loaded.ruleSet.rules.length, 1, "缺 id 规则被跳过，好规则保留");
  assert.equal(loaded.ruleSet.rules[0]?.id, "CON-OK");
  assert.ok(loaded.warnings.some(w => w.message.includes("缺少 id")));
});

test("parseRuleSetFromYaml ignores invalid severityIfFound values", () => {
  const { ruleSet, issues } = parseRuleSetFromYaml(
    `
rules:
  - id: CON-S
    name: s
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"], severityIfFound: "catastrophic" }
`,
  );
  assert.equal(issues.length, 0);
  const rule = ruleSet.rules[0];
  assert.equal(rule?.check.type, "keyword_blocklist");
  if (rule?.check.type === "keyword_blocklist") {
    assert.equal(rule.check.severityIfFound, undefined);
  }
});

test("loadRuleSetFromFile throws on structurally invalid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-test-"));
  const path = join(dir, "bad.yaml");
  writeFileSync(path, "rules: [not an object", "utf8");
  assert.throws(() => loadRuleSetFromFile(path), /加载失败/);
});

test("loadRuleSetDir skips broken files with warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-test-"));
  writeFileSync(join(dir, "a.yaml"), ARRAY_YAML, "utf8");
  writeFileSync(join(dir, "broken.yaml"), "rules: {", "utf8");
  writeFileSync(join(dir, "notes.md"), "not a rule file", "utf8");
  const { ruleSets, warnings } = loadRuleSetDir(dir);
  assert.equal(ruleSets.length, 1);
  assert.ok(warnings.some(w => w.source?.endsWith("broken.yaml")));
  assert.equal(
    warnings.some(w => w.source?.endsWith("notes.md")),
    false,
  );
});

test("loadRuleSetDir returns warning when directory missing", () => {
  const { ruleSets, warnings } = loadRuleSetDir("/nonexistent/rules");
  assert.equal(ruleSets.length, 0);
  assert.ok(warnings.length > 0);
});

test("mergeRuleSets overrides by id with later wins", () => {
  const first = parseRuleSetFromYaml(ARRAY_YAML).ruleSet;
  const second = parseRuleSetFromYaml(
    `
rules:
  - id: CON-101
    name: 覆盖版
    severity: minor
    action: log
    check: { type: keyword_blocklist, keywords: ["x"] }
`,
  ).ruleSet;
  const merged = mergeRuleSets([first, second]);
  assert.equal(merged.rules.length, 1);
  assert.equal(merged.rules[0]?.name, "覆盖版");
});

test("validateRuleSet detects duplicates", () => {
  const set = parseRuleSetFromYaml(
    `
rules:
  - id: D1
    name: a
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"] }
  - id: D1
    name: b
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
  ).ruleSet;
  const issues = validateRuleSet(set, "dup.yaml");
  assert.ok(issues.some(i => i.message.includes("重复的规则 id")));
});
