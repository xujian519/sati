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
