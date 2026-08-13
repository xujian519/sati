import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinPatentManifests,
  patentInfringementManifest,
  patentInvalidationManifest,
  patentOaResponseManifest,
  patentPatentabilityManifest,
  validateWorkflowManifest,
} from "../../../src/patent/index.js";

test("4 个新 manifest 通过校验且含 claim-chart 阶段", () => {
  const expectedChartModes: Record<string, string> = {
    patent_patentability_v1: "patentability",
    patent_oa_response_v1: "oa-response",
    patent_invalidation_v1: "invalidity",
    patent_infringement_v1: "infringement",
  };
  for (const m of [
    patentPatentabilityManifest,
    patentOaResponseManifest,
    patentInvalidationManifest,
    patentInfringementManifest,
  ]) {
    validateWorkflowManifest(m); // 非法抛错
    const chart = m.stages.find(s => s.id === "claim-chart");
    assert.ok(chart, `${m.id} 缺 claim-chart 阶段`);
    assert.equal(chart!.atom, "claim-chart");
    const chartMode = (chart!.params as { chart_mode?: string } | undefined)?.chart_mode;
    assert.equal(chartMode, expectedChartModes[m.id], `${m.id} claim-chart chart_mode 非法`);
    assert.equal(m.stages[m.stages.length - 1]!.id, "approval", `${m.id} 末阶段应为 approval`);
  }
});

test("新 manifest 已注册进 builtinPatentManifests 目录", () => {
  const ids = builtinPatentManifests.map(e => e.manifest.id);
  assert.ok(ids.includes("patent_patentability_v1"));
  assert.ok(ids.includes("patent_oa_response_v1"));
  assert.ok(ids.includes("patent_invalidation_v1"));
  assert.ok(ids.includes("patent_infringement_v1"));
});

test("无效/复审 manifest 复用同一 id（双场景）且 checkDomains 含 patent_invalidation", () => {
  const entry = builtinPatentManifests.find(e => e.manifest.id === "patent_invalidation_v1");
  assert.ok(entry);
  assert.ok(entry!.checkDomains.includes("patent_invalidation"));
});

test("输入键不匹配的阶段不声明 atom（原子路径不支持，回退收口）", () => {
  // T9 遗留修复：novelty 原子输入键为 features/prior_art、reasoning 原子输入键为
  // reasoning_prompt/reasoning_input、draft-claims 原子输入键为 pfe_triples/
  // merge_result——本 manifest 均无对应产出，声明 atom 必然降级；回退收口语义。
  for (const stage of patentInvalidationManifest.stages) {
    if (stage.id === "novelty" || stage.id === "inventiveness") {
      assert.equal(stage.atom, undefined, `${stage.id} 不应声明 atom（输入键不匹配）`);
    }
  }
  const draft = patentPatentabilityManifest.stages.find(s => s.id === "draft");
  assert.ok(draft);
  assert.equal(draft!.atom, undefined, "draft 不应声明 atom（draft-claims 输入键不匹配）");
  // claim-chart 原子输入键 claim/chart_targets/chart_mode 由上下文提供，保留声明。
  const chart = patentInvalidationManifest.stages.find(s => s.id === "claim-chart");
  assert.equal(chart!.atom, "claim-chart");
});
