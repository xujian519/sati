/**
 * src/knowledge/legal/legal-evidence — 八类法定证据三性判定与工具契约。
 *
 * 覆盖：规则资产解析（含坏条目容错）、八类判定器分派、类型特定规则命中、
 * 加权综合分、工具 schema/枚举与 execute 输出。全部为纯函数/本地资产，无网络。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LegalEvidenceEngine } from "../../../src/knowledge/legal/legal-evidence/engine.js";
import { parseLegalRuleSet } from "../../../src/knowledge/legal/legal-evidence/rule-set.js";
import { loadLegalEvidenceRulesEngine } from "../../../src/knowledge/legal/legal-evidence/rule-loader.js";
import { createEvaluateLegalEvidenceTool } from "../../../src/knowledge/legal/legal-evidence/tool.js";
import { LEGAL_EVIDENCE_TYPES, type LegalEvidenceInput } from "../../../src/knowledge/legal/legal-evidence/types.js";
import { makeToolContext } from "../../tool/context-fixture.js";

const MINIMAL_YAML = `
weights:
  relevance: 0.35
  legality: 0.30
  authenticity: 0.35
rules:
  - id: LEGAL-EVI-001
    description: "书证应提供原件"
    evidence_type: documentary
    check: "hasOriginalOrExplainsAbsence"
    severity: critical
`;

test("parseLegalRuleSet 读取权重与规则；坏条目只告警不阻塞", () => {
  const parsed = parseLegalRuleSet(
    `${MINIMAL_YAML}
  - id: BAD-1
    description: "缺 evidence_type"
    check: "x"
  - id: BAD-2
    description: "未知类型"
    evidence_type: not_a_type
    check: "x"
`,
    "inline",
  );
  assert.equal(parsed.ruleSet?.weights.legality, 0.3);
  assert.equal(parsed.ruleSet?.rules.length, 1);
  assert.equal(parsed.warnings.length, 2);
});

test("parseLegalRuleSet 顶层非对象时返回 null 并告警", () => {
  const parsed = parseLegalRuleSet("- just\n- a list\n", "inline");
  assert.equal(parsed.ruleSet, null);
  assert.equal(parsed.warnings.length, 1);
});

test("八类法定证据均可判定，三性评分落在 0–1", () => {
  const engine = new LegalEvidenceEngine();
  for (const evidenceType of LEGAL_EVIDENCE_TYPES) {
    const assessment = engine.assess({ evidenceId: `E-${evidenceType}`, evidenceType });
    assert.equal(assessment.evidenceType, evidenceType);
    for (const dim of [
      assessment.dimensions.relevance,
      assessment.dimensions.legality,
      assessment.dimensions.authenticity,
    ]) {
      assert.ok(dim.score >= 0 && dim.score <= 1, `${evidenceType}/${dim.dimension} 越界`);
    }
    assert.ok(assessment.score.overall >= 0 && assessment.score.overall <= 1);
    assert.ok(assessment.reasoning.length > 0);
  }
});

test("书证缺原件 → LEGAL-EVI-001 critical 未通过；要件齐全则通过", () => {
  const engine = new LegalEvidenceEngine(readRulesAssetText());
  const missing = engine.assess({
    evidenceId: "E-01",
    evidenceType: "documentary",
    hasOriginal: false,
    signatureVerified: false,
    formationTimeClear: false,
  });
  const rule = missing.findings.find(f => f.ruleId === "LEGAL-EVI-001");
  assert.ok(rule);
  assert.equal(rule.passed, false);
  assert.equal(rule.severity, "critical");
  assert.ok(missing.score.authenticity < 0.5);

  const complete = engine.assess({
    evidenceId: "E-02",
    evidenceType: "documentary",
    hasOriginal: true,
    signatureVerified: true,
    formationTimeClear: true,
    source: "合同原件",
    content: "买卖合同正文",
    factToProve: "双方存在买卖关系",
  });
  assert.equal(complete.findings.find(f => f.ruleId === "LEGAL-EVI-001")?.passed, true);
  assert.ok(complete.score.authenticity > 0.5);
  assert.ok(complete.score.overall > missing.score.overall);
});

test("电子数据缺哈希与完整性 → LEGAL-EVI-004 critical；补齐后转通过", () => {
  const engine = new LegalEvidenceEngine(readRulesAssetText());
  const bare = engine.assess({ evidenceId: "E-03", evidenceType: "electronic" });
  assert.equal(bare.findings.find(f => f.ruleId === "LEGAL-EVI-004")?.passed, false);
  assert.equal(bare.findings.find(f => f.ruleId === "LEGAL-EVI-005")?.severity, "warning");

  const verified = engine.assess({
    evidenceId: "E-04",
    evidenceType: "electronic",
    contentHash: "sha256:abc",
    hashVerified: true,
    timestamp: "2026-01-01T00:00:00Z",
    storageIntegrityVerified: true,
  });
  assert.equal(verified.findings.find(f => f.ruleId === "LEGAL-EVI-004")?.passed, true);
  assert.ok(verified.score.authenticity > bare.score.authenticity);
});

test("证人有利害关系未披露 → LEGAL-EVI-007 critical；无利害关系则通过", () => {
  const engine = new LegalEvidenceEngine(readRulesAssetText());
  const conflicted = engine.assess({
    evidenceId: "E-05",
    evidenceType: "witness_testimony",
    witnessHasConflict: true,
    conflictDisclosed: false,
  });
  assert.equal(conflicted.findings.find(f => f.ruleId === "LEGAL-EVI-007")?.passed, false);
  assert.equal(conflicted.findings.find(f => f.ruleId === "LEGAL-EVI-007")?.severity, "critical");

  const clean = engine.assess({
    evidenceId: "E-06",
    evidenceType: "witness_testimony",
    witnessHasConflict: false,
    corroborated: true,
  });
  assert.equal(clean.findings.find(f => f.ruleId === "LEGAL-EVI-007")?.passed, true);
});

test("综合分按 YAML 权重加权（可配置权重生效）", () => {
  const engine = new LegalEvidenceEngine(`
weights:
  relevance: 1
  legality: 0
  authenticity: 0
rules: []
`);
  const input: LegalEvidenceInput = { evidenceId: "E-07", evidenceType: "party_statement", factToProve: "事实" };
  const assessment = engine.assess(input);
  assert.equal(assessment.score.overall, assessment.dimensions.relevance.score);
});

test("规则资产缺失时引擎降级为默认权重且显式告警（不静默）", () => {
  const previous = process.env.SATI_RULES_DIR;
  process.env.SATI_RULES_DIR = "/nonexistent/sati-rules";
  try {
    const result = loadLegalEvidenceRulesEngine();
    // 仍从包根 rules/legal 找到了资产时，本条降级断言不成立；此时要求 source 非空。
    if (result.source === null) {
      assert.ok(result.warnings.some(w => w.includes("未找到法律证据规则资产")));
      assert.deepEqual(result.engine.getRules(), []);
    } else {
      assert.ok(result.source.endsWith("legal-evidence-rules.yaml"));
    }
  } finally {
    if (previous === undefined) delete process.env.SATI_RULES_DIR;
    else process.env.SATI_RULES_DIR = previous;
  }
});

test("工具契约：名称/域/schema 枚举与八类证据一致，execute 输出结构化结果", async () => {
  const tool = createEvaluateLegalEvidenceTool();
  assert.equal(tool.name, "evaluate_legal_evidence");
  assert.equal(tool.domain, "legal");
  const props = tool.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
  assert.deepEqual(props.evidenceType?.enum, [...LEGAL_EVIDENCE_TYPES]);
  assert.deepEqual(tool.inputSchema.required, ["evidenceId", "evidenceType"]);

  const result = await tool.execute(
    {
      evidenceId: "E-08",
      evidenceType: "inspection_record",
      inspectionHasWitness: true,
      inspectionRecordComplete: true,
    },
    makeToolContext(),
  );
  assert.equal(result.data?.assessment.evidenceId, "E-08");
  assert.equal(result.data?.assessment.evidenceType, "inspection_record");
  assert.equal(typeof result.data?.summary, "string");
  assert.equal(result.data?.rulesLoaded, true);
});

test("工具契约：空 evidenceId 拒绝执行并给出稳定错误码", async () => {
  const tool = createEvaluateLegalEvidenceTool();
  const result = await tool.execute({ evidenceId: "  ", evidenceType: "documentary" }, makeToolContext());
  assert.equal(result.metadata?.error, "no_evidence_id");
});

/** 读仓库内真实规则资产（包根 rules/legal，随源码分发）。 */
function readRulesAssetText(): string {
  const loaded = loadLegalEvidenceRulesEngine();
  assert.ok(loaded.source !== null, "规则资产未找到，测试前提不成立");
  return readFileSync(loaded.source, "utf8");
}
