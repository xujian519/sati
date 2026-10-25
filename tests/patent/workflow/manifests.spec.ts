/**
 * 三场景（OA 答复 / 无效 / 侵权）的 dispute_framing 阶段契约（#737）：
 * 阶段顺序、无 atom、parse 描述消费争点范围，以及 scripted executor 的端到端解析。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPUTE_CLAIMS_HEADING,
  DISPUTE_GROUNDS_HEADING,
  patentInfringementManifest,
  patentInventivenessManifest,
  patentNoveltyManifest,
  patentOaResponseManifest,
  patentPatentabilityManifest,
  patentInvalidationManifest,
  parseDisputeFraming,
  runWorkflow,
  validateWorkflowManifest,
} from "../../../src/patent/index.js";
import { StageHandlerRegistry, registerBuiltinAtoms } from "../../../src/patent/atoms/index.js";

const DISPUTE_SCENARIOS = [
  ["patent_oa_response_v1", patentOaResponseManifest],
  ["patent_invalidation_v1", patentInvalidationManifest],
  ["patent_infringement_v1", patentInfringementManifest],
] as const;

test("三场景：dispute_framing 紧跟 parse 之前，且为无 atom 的 chain 阶段", () => {
  for (const [id, manifest] of DISPUTE_SCENARIOS) {
    validateWorkflowManifest(manifest);
    const ids = manifest.stages.map(s => s.id);
    const framingIndex = ids.indexOf("dispute_framing");
    assert.ok(framingIndex >= 0, `${id} 缺 dispute_framing`);
    assert.equal(framingIndex, ids.indexOf("parse") - 1, `${id} 的 dispute_framing 应在 parse 之前`);
    const stage = manifest.stages[framingIndex]!;
    assert.equal(stage.strategy, "chain");
    assert.equal(stage.atom, undefined, "dispute_framing 不声明 atom（文本契约）");
    assert.ok(stage.description.includes(DISPUTE_GROUNDS_HEADING), `${id} 描述缺少 grounds 标记`);
    assert.ok(stage.description.includes(DISPUTE_CLAIMS_HEADING), `${id} 描述缺少 claims 标记`);
  }
});

test("三场景：parse 描述声明消费 dispute_framing；OA 保留程序理由全量解析", () => {
  for (const [id, manifest] of DISPUTE_SCENARIOS) {
    const parse = manifest.stages.find(s => s.id === "parse");
    assert.ok(parse, `${id} 缺 parse`);
    assert.match(parse!.description, /dispute_framing/i, `${id} 的 parse 应消费争点范围`);
  }
  const oaParse = patentOaResponseManifest.stages.find(s => s.id === "parse");
  assert.match(oaParse!.description, /程序理由/, "OA 的程序理由必须全量解析");
  assert.match(oaParse!.description, /全量解析/);
});

test("novelty / inventiveness / patentability 不插 dispute_framing", () => {
  for (const manifest of [patentNoveltyManifest, patentInventivenessManifest, patentPatentabilityManifest]) {
    assert.ok(
      !manifest.stages.some(s => s.id === "dispute_framing"),
      `${manifest.id} 不应有 dispute_framing（不围绕对方主张展开）`,
    );
    validateWorkflowManifest(manifest);
  }
});

test("端到端：三场景按 dispute_framing → parse 执行，阶段输出可按契约解析", async () => {
  registerBuiltinAtoms();
  const framingText = [
    DISPUTE_GROUNDS_HEADING,
    "- 创造性（专利法第22条第3款）",
    DISPUTE_CLAIMS_HEADING,
    "- 权利要求1",
    "- 权利要求3",
  ].join("\n");
  for (const [id, manifest] of DISPUTE_SCENARIOS) {
    const result = await runWorkflow(
      manifest,
      { input: "案情材料" },
      async stage => (stage.id === "dispute_framing" ? framingText : `[${stage.id}] 产出`),
      { handlers: new StageHandlerRegistry() },
    );
    assert.equal(result.completed, true, `${id} 应完整执行`);
    const ids = result.stages.map(s => s.stageId);
    assert.equal(ids[0], "dispute_framing", `${id} 首阶段应为 dispute_framing`);
    assert.equal(ids[1], "parse", `${id} 第二阶段应为 parse`);
    assert.deepEqual(parseDisputeFraming(result.stages[0]!.output), {
      grounds: ["创造性（专利法第22条第3款）"],
      claims: ["权利要求1", "权利要求3"],
      unidentified: false,
    });
  }
});
