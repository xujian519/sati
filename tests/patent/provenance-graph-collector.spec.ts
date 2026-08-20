import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphBuilder } from "../../src/patent/graph/index.js";
import { INVENTIVENESS_INPUT_DECLARATIONS } from "../../src/patent/graph/domains/inventiveness.js";
import { ProvenanceStore } from "../../src/patent/provenance/provenance-store.js";
import { ProvenanceCollector } from "../../src/patent/provenance/collector.js";
import { caseProvenanceDir } from "../../src/patent/paths.js";

function collectorFor(cwd: string, runId: string): ProvenanceCollector {
  const store = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
  return new ProvenanceCollector({ store, runId, caseId: "case-1" });
}

test("wrapNode：节点执行记 activity（含 stepIndex）+ 产出 snapshot（REPLACE 最新值）+ derivedFrom（声明表）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-graph-"));
  try {
    const collector = collectorFor(cwd, "patent_inventiveness-1-1");
    // 自定义声明：b 依赖 a 的产出 key_a（模拟真实声明表语义）
    const declarations: Record<string, readonly string[]> = { b: ["key_a"] };
    const builder = new GraphBuilder({
      onAddNode: (name, node) => collector.wrapNode(name, node, declarations[name]),
    });
    // 两节点链：a 产出 key_a；b 声明依赖 key_a（含裸箭头节点）
    builder.addNode("a", async () => ({ key_a: "value-a" }));
    builder.addNode("b", async () => ({ key_b: "value-b" }));
    builder.addEdge("a", "b");
    builder.addEdge("b", "__end__");

    // 模拟工具层接线：onSuperStepStart 维护 collector 当前超步号
    const graph = builder.compile("a");
    await graph.run({}, { onSuperStepStart: step => collector.setCurrentStep(step) });

    // 通过重新打开 store 验证（collector 内部 store 不暴露 list）
    collector.close();
    const reopened = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
    const all = reopened.listActivities("case-1");
    assert.equal(all.length, 2);
    const a = all.find(x => x.name === "a");
    const b = all.find(x => x.name === "b");
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(a!.stepIndex, 0);
    assert.equal(b!.stepIndex, 1);
    // b 的 derivedFrom（声明表输入 key_a）→ a 的 snapshot entity id
    assert.deepEqual(b!.inputIds, ["patent_inventiveness-1-1:snapshot:key_a"]);
    // snapshot entities：key_a/key_b
    const entities = reopened.listEntities("case-1");
    assert.deepEqual(
      entities.filter(e => e.kind === "state_snapshot").map(e => e.id),
      ["patent_inventiveness-1-1:snapshot:key_a", "patent_inventiveness-1-1:snapshot:key_b"],
    );
    assert.equal(entities.find(e => e.id.endsWith("snapshot:key_a"))!.value, "value-a");
    reopened.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("wrapNode：LWW 重写键 snapshot 反映最新值（REPLACE）且 activity 幂等", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-graph-"));
  try {
    const collector = collectorFor(cwd, "patent_inventiveness-1-1");
    const builder = new GraphBuilder({ onAddNode: (name, node) => collector.wrapNode(name, node, []) });
    builder.addNode("rewrite", async () => ({ query: "v1" }));
    builder.addEdge("rewrite", "__end__");
    const graph = builder.compile("rewrite");
    // 第一轮：v1；resume 重放（同 runId、同 step）→ v2，upsert 不产生重复 activity
    await graph.run({});
    collector.setCurrentStep(0);
    await graph.run({});
    collector.close();

    const reopened = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
    const activities = reopened.listActivities("case-1");
    assert.equal(activities.length, 1); // 同 step 同节点幂等（INSERT OR IGNORE）
    const snapshots = reopened.listEntities("case-1").filter(e => e.kind === "state_snapshot");
    assert.equal(snapshots.length, 1); // REPLACE：仍一条
    reopened.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("recordDegradations：降级标记记 activity + degraded entity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-graph-"));
  try {
    const collector = collectorFor(cwd, "patent_novelty-1-1");
    collector.recordDegradations([
      { reason: "node_failed", message: "节点 search 执行失败", severity: "critical" },
      { reason: "llm_unavailable", message: "closest 需要 LLM", severity: "warning" },
    ]);
    collector.close();

    const reopened = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
    const activities = reopened.listActivities("case-1");
    assert.equal(activities.length, 2);
    assert.ok(activities.every(a => a.source === "degradation"));
    const entities = reopened.listEntities("case-1");
    assert.ok(entities.every(e => e.degraded === true));
    reopened.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("INVENTIVENESS_INPUT_DECLARATIONS：conclude 声明含 closest/diff/hint（结论树验收依据）", () => {
  const conclude = INVENTIVENESS_INPUT_DECLARATIONS.conclude;
  assert.ok(conclude.includes("inventiveness_closest"));
  assert.ok(conclude.includes("inventiveness_diff"));
  assert.ok(conclude.includes("inventiveness_hint"));
  // rule_gate/approval 不声明（collectStateText 读全量 / 审批门独立记录，评审 P13）
  assert.equal(INVENTIVENESS_INPUT_DECLARATIONS.rule_gate, undefined);
  assert.equal(INVENTIVENESS_INPUT_DECLARATIONS.approval, undefined);
});
