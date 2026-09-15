import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_GRANTED_OUTPUT, AtomRegistry, type StageHandler } from "../../../src/patent/atoms/index.js";
import {
  clearStageOutputs,
  isApprovalGateStage,
  resolveStageOutput,
} from "../../../src/patent/workflow/stage-primitives.js";
import type { WorkflowStage } from "../../../src/patent/workflow/types.js";

/**
 * 阶段执行原语（#345）的直接单测。
 *
 * 存在的理由：这两个函数是「主输出键解析 / 空输出兜底 / 审批门占位」与
 * 「回退清理」的唯一实现，graph 与 workflow 两侧都经它出结果——原先两处
 * 各写一份时已经漂移（图路径缺审批门占位）。把语义钉在这里，比只测两侧
 * 集成更能定位回归。
 */

const approvalHandler: StageHandler = {
  name: "approval-gate",
  category: "gate",
  execute: async () => ({}),
};

const clarityHandler: StageHandler = {
  name: "clarity-gate",
  category: "gate",
  execute: async () => ({}),
};

const plainHandler: StageHandler = {
  name: "extract",
  category: "extract",
  execute: async () => ({}),
};

// ---------------------------------------------------------------------------
// isApprovalGateStage
// ---------------------------------------------------------------------------

test("isApprovalGateStage: undefined handler 不抛错（图路径 handler 可能未注册）", () => {
  assert.equal(isApprovalGateStage(undefined), false);
});

test("isApprovalGateStage: 两类人工放行门均命中，其余 handler 不命中", () => {
  assert.equal(isApprovalGateStage(approvalHandler), true);
  assert.equal(isApprovalGateStage(clarityHandler), true, "clarity-gate 同属人工放行型门");
  assert.equal(isApprovalGateStage(plainHandler), false);
});

// ---------------------------------------------------------------------------
// resolveStageOutput —— 主输出键解析
// ---------------------------------------------------------------------------

test("resolveStageOutput: 主输出键为字符串 → 原样返回", () => {
  const output = resolveStageOutput({
    segment: { report_text: "检索报告" },
    mainKey: "report_text",
    fallbackValue: "旧值",
  });
  assert.equal(output, "检索报告");
});

test("resolveStageOutput: 主输出键为非字符串（数组/对象）→ JSON 序列化（缩进 2）", () => {
  assert.equal(
    resolveStageOutput({ segment: { features: ["特征A", "特征B"] }, mainKey: "features" }),
    JSON.stringify(["特征A", "特征B"], null, 2),
  );
  assert.equal(
    resolveStageOutput({ segment: { verdict: { pass: true } }, mainKey: "verdict" }),
    JSON.stringify({ pass: true }, null, 2),
  );
});

test("resolveStageOutput: 主输出键缺省（atom 未声明主输出）→ 空串，不误取 segment 其他键", () => {
  const output = resolveStageOutput({ segment: { other: "有值但不是主输出键" }, mainKey: undefined });
  assert.equal(output, "");
});

test("resolveStageOutput: 主输出键存在但值为 undefined → 视作空（走兜底）", () => {
  const output = resolveStageOutput({
    segment: { report_text: undefined },
    mainKey: "report_text",
    fallbackValue: "兜底",
  });
  assert.equal(output, "兜底");
});

// ---------------------------------------------------------------------------
// resolveStageOutput —— 空输出兜底与审批门占位
// ---------------------------------------------------------------------------

test("resolveStageOutput: 输出全空白 → 回退兜底值（非仅空串，空白也算空）", () => {
  assert.equal(resolveStageOutput({ segment: {}, mainKey: "k", fallbackValue: "上一轮" }), "上一轮");
  assert.equal(resolveStageOutput({ segment: { k: "   \n" }, mainKey: "k", fallbackValue: "上一轮" }), "上一轮");
});

test('resolveStageOutput: 无兜底值（undefined）→ 空串，不产出 "undefined" 字面量', () => {
  assert.equal(resolveStageOutput({ segment: undefined, mainKey: undefined }), "");
  assert.equal(resolveStageOutput({ segment: {}, mainKey: "k", fallbackValue: undefined }), "");
  assert.equal(resolveStageOutput({ segment: {}, mainKey: "k", fallbackValue: null }), "");
});

test("resolveStageOutput: 已放行审批门且无实质输出 → 占位 APPROVED（语义 = 人工批准，非降级）", () => {
  assert.equal(resolveStageOutput({ segment: {}, mainKey: undefined, approvedGate: true }), APPROVAL_GRANTED_OUTPUT);
  assert.equal(APPROVAL_GRANTED_OUTPUT, "APPROVED");
});

test("resolveStageOutput: 审批门占位只在**仍为空**时生效，不覆盖真实产出", () => {
  // 审批门阶段带了主输出（如自定义 handler）→ 占位不得覆盖
  assert.equal(
    resolveStageOutput({ segment: { review_passed: "已确认" }, mainKey: "review_passed", approvedGate: true }),
    "已确认",
  );
  // 兜底值非空 → 占位不介入（顺序：主输出 → 兜底 → 占位）
  assert.equal(resolveStageOutput({ segment: {}, mainKey: "k", fallbackValue: "兜底", approvedGate: true }), "兜底");
});

test("resolveStageOutput: 未放行的审批门保持空输出（该场景下 handler 本会抛中断）", () => {
  assert.equal(resolveStageOutput({ segment: {}, mainKey: undefined, approvedGate: false }), "");
});

// ---------------------------------------------------------------------------
// clearStageOutputs
// ---------------------------------------------------------------------------

function makeAtoms(): AtomRegistry {
  const registry = new AtomRegistry();
  registry.register({
    name: "extract",
    description: "提取",
    category: "extract",
    inputSchema: ["text"],
    outputSchema: ["features", "problems", "effects"],
  });
  registry.register({ name: "reasoning", description: "推理", category: "reason", inputSchema: [], outputSchema: [] });
  return registry;
}

test("clearStageOutputs: 删 stage-id 键 + 该 atom 的 outputSchema 全部键（不只 stage-id）", () => {
  const atoms = makeAtoms();
  const stages: WorkflowStage[] = [
    { id: "extract_features", strategy: "chain", description: "提取", atom: "extract" },
    { id: "check", strategy: "chain", description: "检查", atom: "reasoning" },
  ];
  const state: Record<string, unknown> = {
    input: "交底书",
    extract_features: "旧输出",
    features: ["旧特征"],
    problems: ["旧问题"],
    effects: ["旧效果"],
    check: "旧一致性",
  };
  clearStageOutputs({ state, stages, atoms });
  assert.deepEqual(state, { input: "交底书" }, "仅剩未被回退的 state 键");
});

test("clearStageOutputs: 无 atom 阶段只删 stage-id 键；范围之外的阶段不受影响", () => {
  const atoms = makeAtoms();
  const stages: WorkflowStage[] = [
    { id: "preprocess", strategy: "chain", description: "预处理" },
    { id: "extract_features", strategy: "chain", description: "提取", atom: "extract" },
  ];
  const state: Record<string, unknown> = {
    preprocess: "旧预处理",
    extract_features: "旧输出",
    features: ["旧特征"],
    report: "后续阶段输出（不在清理范围内）",
  };
  clearStageOutputs({ state, stages: [stages[0]!], atoms });
  assert.deepEqual(state, {
    extract_features: "旧输出",
    features: ["旧特征"],
    report: "后续阶段输出（不在清理范围内）",
  });
});

test("clearStageOutputs: atom 未注册时不抛错（只清 stage-id 键）", () => {
  const atoms = makeAtoms();
  const state: Record<string, unknown> = { ghost: "输出", features: ["不该删"] };
  clearStageOutputs({
    state,
    stages: [{ id: "ghost", strategy: "chain", description: "未注册原子", atom: "no-such-atom" }],
    atoms,
  });
  assert.deepEqual(state, { features: ["不该删"] });
});
