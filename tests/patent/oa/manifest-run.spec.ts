import assert from "node:assert/strict";
import test from "node:test";
import {
  patentOaResponseManifest,
  registerBuiltinAtoms,
  type StageProvider,
  type WorkflowStage,
  runWorkflow,
} from "../../../src/patent/index.js";

registerBuiltinAtoms();

const CLAIM = "1. 一种装置，包括壳体和设置在壳体内的电机。";

const MATERIAL = [
  "## original_application",
  "本发明公开了一种装置，包括壳体和设置在壳体内的电机。",
  "## proposed_limitations",
  "- 设置在壳体内的电机",
  "权利要求1不具备创造性。",
].join("\n");

function chartOutput(): string {
  return JSON.stringify({
    elements: [{ id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" }],
    rows: [
      {
        elementId: "1a",
        targetId: "D1",
        quote: "壳体",
        pinCite: "[D1 段[0032]]",
        mapping: "literal",
      },
    ],
  });
}

function notesOutput(): string {
  return JSON.stringify({
    notes: [{ text: "1a 已在 D1 中公开。", refs: ["1a"] }],
  });
}

const provider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("notes")) return notesOutput();
    if (prompt.includes("要素") || prompt.includes("claim")) return chartOutput();
    return chartOutput();
  },
  search: async () => [],
};

/** 自动路径的无 atom 阶段由 executor 提供占位输出（生产路径回显 input）。 */
const executor = async (stage: WorkflowStage): Promise<string> =>
  stage.id === "dispute_framing" ? "未识别争点" : MATERIAL;

test("patent_oa_response_v1: draft 阶段声明原子，自动路径产出意见陈述草稿", async () => {
  const manifest = {
    ...patentOaResponseManifest,
    stages: patentOaResponseManifest.stages.filter(stage => stage.id !== "approval"),
  };
  const result = await runWorkflow(
    manifest,
    {
      text: MATERIAL,
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1" }]),
    },
    executor,
    { provider },
  );

  const draft = result.stages.find(stage => stage.stageId === "draft");
  assert.ok(draft, "draft 阶段存在");
  assert.equal(draft!.atom, "draft-oa");
  assert.equal(draft!.degraded, false);

  const statement = JSON.parse(draft!.output) as {
    status: string;
    draftNotice: string;
    amendments: { status: string; items: Array<{ status: string }> };
  };
  assert.equal(statement.status, "draft");
  assert.equal(statement.draftNotice.includes("须由署名代理人复核"), true);
  assert.equal(statement.amendments.items[0]?.status, "anchored");
});

test("patent_oa_response_v1: 缺修改段时仍产出草稿，并标记未核对", async () => {
  const manifest = {
    ...patentOaResponseManifest,
    stages: patentOaResponseManifest.stages.filter(stage => stage.id !== "approval"),
  };
  const plain = "权利要求1不具备创造性。";
  const result = await runWorkflow(
    manifest,
    {
      text: plain,
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1" }]),
    },
    async () => plain,
    { provider },
  );

  const draft = result.stages.find(stage => stage.stageId === "draft");
  const statement = JSON.parse(draft!.output) as {
    amendments: { status: string; items: Array<{ status: string }> };
  };
  assert.equal(statement.amendments.status, "not_checked");
  assert.equal(statement.amendments.items[0]?.status, "not_checked");
});
