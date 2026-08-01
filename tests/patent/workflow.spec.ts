import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowError,
  patentNoveltyManifest,
  runWorkflow,
  validateWorkflowManifest,
  type WorkflowContext,
  type WorkflowManifest,
  type WorkflowStage,
} from "../../src/patent/workflow.js";

function okExecutor(stage: WorkflowStage, ctx: WorkflowContext): Promise<string> {
  return Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);
}

test("validateWorkflowManifest rejects malformed manifests", () => {
  assert.throws(() => validateWorkflowManifest({ id: "", name: "x", caseType: "y", stages: [] }), WorkflowError);
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "w",
        name: "x",
        caseType: "y",
        stages: [
          { id: "a", strategy: "chain", description: "d" },
          { id: "a", strategy: "chain", description: "d" },
        ],
      }),
    WorkflowError,
  );
  assert.throws(
    () =>
      validateWorkflowManifest({
        id: "w",
        name: "x",
        caseType: "y",
        stages: [{ id: "a", strategy: "magic", description: "d" } as never],
      }),
    WorkflowError,
  );
});

test("runWorkflow executes all stages and reports completion", async () => {
  const result = await runWorkflow(patentNoveltyManifest, { input: "一种自动化分拣装置" }, okExecutor);
  assert.equal(result.manifestId, "patent_novelty_v1");
  assert.equal(result.completed, true);
  assert.equal(result.stages.length, 5);
  assert.deepEqual(result.degradedSteps, []);
  assert.match(result.summary, /5\/5 阶段完成/);
});

test("runWorkflow marks degraded stages without aborting", async () => {
  const flakyExecutor = (stage: WorkflowStage): Promise<string> => {
    if (stage.id === "compare") return Promise.resolve("");
    return Promise.resolve(`[${stage.id}] 完成`);
  };
  const result = await runWorkflow(patentNoveltyManifest, {}, flakyExecutor);
  assert.equal(result.completed, false);
  assert.deepEqual(result.degradedSteps, ["compare"]);
  assert.ok(result.stages.find(s => s.stageId === "compare")?.degraded);
});

test("runWorkflow retries failed stages up to maxRetries", async () => {
  const manifest: WorkflowManifest = {
    id: "retry_wf",
    name: "重试工作流",
    caseType: "test",
    stages: [{ id: "s1", strategy: "chain", description: "先失败后成功" }],
    validation: { maxRetries: 3 },
  };
  let calls = 0;
  const executor = async (): Promise<string> => {
    calls += 1;
    if (calls < 3) throw new Error("临时失败");
    return "成功输出";
  };
  const result = await runWorkflow(manifest, {}, executor);
  assert.equal(result.stages[0].output, "成功输出");
  assert.equal(result.stages[0].degraded, false);
  assert.equal(calls, 3);
});

test("novelty manifest covers the full five-stage analysis chain", () => {
  assert.equal(patentNoveltyManifest.stages.length, 5);
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.id),
    ["parse", "search", "compare", "conclude", "approval"],
  );
  assert.equal(patentNoveltyManifest.caseType, "novelty_search");
  assert.deepEqual(
    patentNoveltyManifest.stages.map(s => s.strategy),
    ["chain", "react", "chain", "chain", "chain"],
  );
});
