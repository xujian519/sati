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
