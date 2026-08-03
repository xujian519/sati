import assert from "node:assert/strict";
import test from "node:test";
import { RuleOutputGate, loadPatentComplianceRuleSet } from "../../src/rule/index.js";

test("loadPatentComplianceRuleSet finds the bundled patent asset", () => {
  const loaded = loadPatentComplianceRuleSet();
  assert.ok(loaded.source !== null, "应能找到 rules/patent/compliance.yaml");
  assert.equal(loaded.ruleSet.rules.length, 4, "应含 4 条专利合规规则");
  const ids = loaded.ruleSet.rules.map(r => r.id);
  assert.ok(ids.includes("PAT-RISK-001"));
  assert.ok(ids.includes("PAT-APPROVAL-001"));
  assert.ok(ids.includes("PAT-ABS-001"));
  assert.ok(ids.includes("PAT-CITE-001"));
});

test("patent compliance gate flags risk, approval, absolute and citation violations", () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  const gate = new RuleOutputGate(ruleSet);

  const risk = gate.process("该方案存在侵权风险。");
  assert.ok(risk.warnHits.includes("PAT-RISK-001"));
  assert.equal(risk.needsApproval, false);

  // negationContext：否定语境不误报
  const negated = gate.process("该方案不构成侵权。");
  assert.equal(negated.warnHits.includes("PAT-RISK-001"), false);

  const approval = gate.process("专利结论：具备新颖性。");
  assert.ok(approval.reviewHits.includes("PAT-APPROVAL-001"));
  assert.equal(approval.needsApproval, true);

  const absolute = gate.process("该方案必然成功。");
  assert.ok(absolute.warnHits.includes("PAT-ABS-001"));

  const citation = gate.process("依据专利法第99条。");
  assert.ok(citation.warnHits.includes("PAT-CITE-001"));

  const clean = gate.process("本方案采用特定装置提高效率。");
  assert.equal(clean.violations.length, 0);
  assert.equal(clean.text, "本方案采用特定装置提高效率。");
});

test("patent compliance gate does not flag valid citations", () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  const gate = new RuleOutputGate(ruleSet);
  const result = gate.process("依据专利法第22条，本申请具备新颖性和创造性。");
  assert.equal(result.warnHits.includes("PAT-CITE-001"), false);
});

test("patent compliance gate parses 百位中文数字（第一百零二条 不再逃逸）", () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  const gate = new RuleOutputGate(ruleSet);
  // 专利法共 82 条：第一百零二条 超出范围 → 必须被核验标记（D3 修复前 parseCnNumber
  // 无法解析"一百零二"，引用被静默跳过、逃逸法条核验）
  const result = gate.process("依据专利法第一百零二条规定处理。");
  assert.ok(result.warnHits.includes("PAT-CITE-001"), "超出范围的百位引用必须被标记");
  assert.match(result.text, /PAT-CITE-001/);
  // 范围内百位引用不误报（实施细则第126条场景——虽然 R1 对细则不生效，解析正确即放行）
  const ok = gate.process("依据专利法实施细则第一百零二条的规定。");
  assert.equal(ok.warnHits.includes("PAT-CITE-001"), false, "细则 max 未设，R1 不核验");
});
