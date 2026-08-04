import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowError,
  manifestToFlowGraph,
  patentDisclosureManifest,
  patentNoveltyManifest,
  validateWorkflowManifest,
  validateWorkflowManifestDag,
  workflowManifestToMermaid,
  type WorkflowManifest,
} from "../../src/patent/index.js";

/** rewindTo 指向后续阶段的 manifest：被“指向不存在的阶段”拦截（ids 顺序收集的隐含约束）。 */
const rewindForward: WorkflowManifest = {
  id: "fwd_v1",
  name: "前向回退",
  caseType: "test",
  stages: [
    { id: "a", strategy: "chain", description: "A" },
    { id: "b", strategy: "chain", description: "B", retry: { whenOutputMatches: "信号", rewindTo: "c" } },
    { id: "c", strategy: "chain", description: "C" },
  ],
};

test("validateWorkflowManifest enforces rewindTo must point to an earlier stage", () => {
  assert.throws(
    () => validateWorkflowManifest(rewindForward),
    (err: unknown) => err instanceof WorkflowError && /rewindTo 指向不存在的阶段/.test((err as Error).message),
  );
});

test("validateWorkflowManifest accepts acyclic rewinds (builtin manifests)", () => {
  assert.doesNotThrow(() => validateWorkflowManifest(patentNoveltyManifest));
  // disclosure 的 consistency → extract_problem 是“顺序边 + 回退边”的合法受控回退，
  // 非死循环（rewindCounts 有界），校验必须放行。
  assert.doesNotThrow(() => validateWorkflowManifest(patentDisclosureManifest));
});

test("validateWorkflowManifestDag reports no problems for builtin manifests", () => {
  // 顺序链图（不含回退边）是严格 DAG：无环、无孤儿。
  assert.deepEqual(validateWorkflowManifestDag(patentNoveltyManifest), []);
  assert.deepEqual(validateWorkflowManifestDag(patentDisclosureManifest), []);
});

test("manifestToFlowGraph builds a schedulable DAG (topological levels)", () => {
  const graph = manifestToFlowGraph(patentDisclosureManifest);
  const levels = graph.topologicalLevels();
  const flat = levels.flat();
  assert.equal(flat.length, patentDisclosureManifest.stages.length);
  assert.equal(new Set(flat).size, flat.length); // 每个阶段恰好出现一次（无环）
});

test("workflowManifestToMermaid renders sequential (solid) and rewind (dashed) edges", () => {
  const mermaid = workflowManifestToMermaid(patentDisclosureManifest);
  assert.ok(mermaid.startsWith("flowchart TD"));
  assert.ok(mermaid.includes("preprocess --> extract_problem"));
  assert.ok(mermaid.includes("consistency -.-> extract_problem"), "回退边应为虚线 -.->");
  assert.ok(mermaid.includes('review_gate["人工复核披露分析报告（中断等待确认）"]'));
});

test("workflowManifestToMermaid renders plain chain for acyclic novelty manifest", () => {
  const mermaid = workflowManifestToMermaid(patentNoveltyManifest);
  assert.ok(mermaid.includes("parse --> search"));
  assert.ok(!mermaid.includes("-.->"), "无回退边时不输出虚线");
});
