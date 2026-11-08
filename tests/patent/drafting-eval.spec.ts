/**
 * #830 M5：起草质量 rubric 评测。
 *
 * - 五维权重不变量（合计 100、全覆盖、无维度间依赖）；
 * - 金标语料 ≥20 件（clean/defect）；
 * - clean 全过线、defect 全在声明维度失分；
 * - 子图信号可覆盖确定性代理（降级可见）；
 * - 起草管线运行器（mock provider，无 API key）能取出 claims/spec。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DRAFTING_RUBRIC,
  DRAFTING_RUBRIC_TOTAL,
  evaluateDraftingGolden,
  parseDraftingGoldenJsonl,
  runDraftingPipeline,
  scoreDraftingArtifacts,
  type DraftingGoldenCase,
  type DraftingSignals,
  type StageProvider,
} from "../../src/patent/index.js";

const CORPUS = "tests/patent/fixtures/drafting-golden/cases.jsonl";

function loadCases(): DraftingGoldenCase[] {
  return parseDraftingGoldenJsonl(readFileSync(CORPUS, "utf8"), CORPUS);
}

test("rubric：五维全覆盖、权重合计 100、维度声明唯一", () => {
  assert.equal(DRAFTING_RUBRIC.length, 5);
  assert.equal(DRAFTING_RUBRIC_TOTAL, 100);
  assert.deepEqual(DRAFTING_RUBRIC.map(dimension => dimension.id).sort(), [
    "anti_slop",
    "claim_layout",
    "claim_support_clarity",
    "enablement",
    "structure",
  ]);
  for (const dimension of DRAFTING_RUBRIC) {
    assert.ok(dimension.weight > 0, `${dimension.id} 权重必须为正`);
    assert.ok(dimension.evidence.length > 0, `${dimension.id} 必须声明可观察证据`);
  }
});

test("金标语料：≥20 件、clean/defect 两类、id 唯一、字段非空", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 20, `至少 20 件，实际 ${cases.length}`);
  assert.ok(cases.some(item => item.class === "clean"));
  assert.ok(cases.some(item => item.class === "defect"));
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) {
    assert.ok(item.disclosure.trim().length > 0, `${item.id} 交底为空`);
    assert.ok(item.claims.trim().length > 0, `${item.id} 权项为空`);
    assert.ok(item.spec.trim().length > 0, `${item.id} 说明书为空`);
    if (item.class === "defect") {
      assert.ok((item.expectedFailures ?? []).length > 0, `${item.id} defect 用例必须声明期望失分维度`);
    }
  }
});

test("批量评测：clean 全过线、defect 全在期望维度失分", () => {
  const report = evaluateDraftingGolden(loadCases());
  assert.equal(report.clean.count, 10);
  assert.equal(report.defect.count, 10);
  assert.equal(
    report.clean.passRate,
    1,
    `clean 未过线：${report.cases
      .filter(item => item.class === "clean" && !item.passed)
      .map(item => item.id)
      .join("、")}`,
  );
  assert.equal(report.defect.detectionRate, 1);
  assert.ok(report.clean.mean >= 85, `clean 均分过低：${report.clean.mean}`);
  assert.ok(report.defect.mean < report.clean.mean);
  // 金标语料携带子图结论（R1）→ A26.3 / A26.4 已被子图核验，
  // 不得再列为"未核验"；未核验列表只剩确定性代理维度。
  assert.ok(!report.unverifiedDimensions.includes("enablement"));
  assert.ok(!report.unverifiedDimensions.includes("claim_support_clarity"));
});

test("批量评测：同输入重复评分结果一致（确定性）", () => {
  const cases = loadCases();
  assert.deepEqual(evaluateDraftingGolden(cases), evaluateDraftingGolden(cases));
});

test("子图信号：覆盖确定性代理并标记 signalSource=graph", () => {
  const [cleanCase] = loadCases().filter(item => item.class === "clean");
  assert.ok(cleanCase !== undefined);
  const signals: DraftingSignals = {
    enablement: { sufficientlyDisclosed: false },
    claimBreadth: { supportOk: false, clarityOk: true },
  };
  const result = scoreDraftingArtifacts(
    {
      claims: cleanCase.claims,
      spec: cleanCase.spec,
      requiredFeatures: cleanCase.requiredFeatures ?? [],
    },
    signals,
  );
  const enablement = result.dimensions.find(dimension => dimension.id === "enablement");
  const claimBreadth = result.dimensions.find(dimension => dimension.id === "claim_support_clarity");
  assert.equal(enablement?.score, 0);
  assert.equal(enablement?.signalSource, "graph");
  assert.equal(claimBreadth?.score, 12, "support=false → 0 分；clarity=true → 12 分");
  assert.equal(claimBreadth?.signalSource, "graph");
  assert.deepEqual(result.unverifiedDimensions.sort(), ["anti_slop", "claim_layout", "structure"]);
});

test("起草管线运行器：mock provider 也能产出 claims/spec", async () => {
  const provider: StageProvider = {
    caseId: "drafting-eval-spec",
    async callLLM(prompt: string): Promise<string> {
      if (prompt.includes("权利要求布局策略专家")) {
        return JSON.stringify({
          subject: "一种测试分拣装置",
          independent_features: ["传送带", "视觉识别模块", "分拣机械臂"],
          dependent_claims: [{ depends_on: [1], features: ["视觉识别模块为深度相机"] }],
          rationale: "独权覆盖全部必要技术特征",
        });
      }
      if (prompt.includes("中国专利说明书撰写专家")) {
        return JSON.stringify({
          title: "一种测试分拣装置",
          sections: [
            { name: "技术领域", content: "本发明涉及分拣装置技术领域。" },
            { name: "背景技术", content: "现有人工分拣效率低。" },
            { name: "发明内容", content: "本发明提供一种测试分拣装置，包括传送带、视觉识别模块与分拣机械臂。" },
            { name: "具体实施方式", content: "实施例1：传送带、视觉识别模块与分拣机械臂协同工作。" },
            { name: "摘要", content: "本发明公开一种测试分拣装置。" },
          ],
        });
      }
      return "默认推理结论";
    },
  };

  const run = await runDraftingPipeline("一种测试分拣装置，包括传送带、视觉识别模块与分拣机械臂。", { provider });
  assert.ok(run.claims.includes("一种测试分拣装置"), run.claims);
  assert.ok(run.spec.includes("技术领域"), run.spec);
  assert.ok(Array.isArray(run.degradedSteps));
});
