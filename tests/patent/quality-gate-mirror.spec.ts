import assert from "node:assert/strict";
import test from "node:test";
import { loadPatentComplianceRuleSet } from "../../src/rule/index.js";
import { ABSOLUTE_PHRASES, PATENT_APPROVAL_KEYWORDS, PATENT_RISK_KEYWORDS } from "../../src/patent/quality-gate.js";
import {
  CASE_OUTPUTS_REL,
  CASE_ROOT_REL,
  CASE_WORKFLOW_RUNS_REL,
  caseOutputsDir,
  caseWorkflowRunsDir,
} from "../../src/patent/paths.js";

/**
 * 双轨镜像一致性校验：
 * rules/patent/compliance.yaml（宪法规则引擎消费）与 quality-gate.ts 关键词表
 * （PatentOutputGate / patent_eval 消费）互为声明式镜像——改任一处的关键词
 * 列表必须同步另一处。本测试在 CI 中强制两处一致，消除静默漂移。
 */

function complianceKeywords(ruleId: string): string[] {
  const { ruleSet } = loadPatentComplianceRuleSet();
  const rule = ruleSet.rules.find(r => r.id === ruleId);
  assert.ok(rule, `compliance.yaml 应包含规则 ${ruleId}`);
  assert.equal(rule.check?.type, "keyword_blocklist", `${ruleId} 应为 keyword_blocklist`);
  return (rule.check?.keywords ?? []).map(k => String(k));
}

test("镜像一致性：PAT-RISK-001 关键词 == PATENT_RISK_KEYWORDS", () => {
  assert.deepEqual([...complianceKeywords("PAT-RISK-001")].sort(), [...PATENT_RISK_KEYWORDS].sort());
});

test("镜像一致性：PAT-APPROVAL-001 关键词 == PATENT_APPROVAL_KEYWORDS", () => {
  assert.deepEqual([...complianceKeywords("PAT-APPROVAL-001")].sort(), [...PATENT_APPROVAL_KEYWORDS].sort());
});

test("镜像一致性：PAT-ABS-001 关键词 == ABSOLUTE_PHRASES", () => {
  assert.deepEqual([...complianceKeywords("PAT-ABS-001")].sort(), [...ABSOLUTE_PHRASES].sort());
});

test("路径常量：caseOutputsDir / caseWorkflowRunsDir 与既有字面量约定一致", () => {
  assert.equal(CASE_ROOT_REL, "data/cases");
  assert.equal(CASE_OUTPUTS_REL, "outputs");
  assert.equal(CASE_WORKFLOW_RUNS_REL, "workflow-runs");
  assert.equal(caseOutputsDir("abc"), "data/cases/abc/outputs");
  assert.equal(caseWorkflowRunsDir("abc"), "data/cases/abc/workflow-runs");
  // worker-contract 占位用法（{caseId} 原样保留）
  assert.equal(caseOutputsDir("{caseId}"), "data/cases/{caseId}/outputs");
});
