import assert from "node:assert/strict";
import test from "node:test";
import {
  AtomRegistry,
  InterruptStageError,
  StageHandlerRegistry,
  type StageHandler,
} from "../../../src/patent/atoms/index.js";
import { runStageOnce } from "../../../src/patent/workflow/executor.js";
import type { WorkflowStage } from "../../../src/patent/workflow/types.js";

const APPROVAL_GRANTED_KEY = "__approval_granted__";

function makeRegistry(handler?: StageHandler): { handlers: StageHandlerRegistry; atoms: AtomRegistry } {
  const handlers = new StageHandlerRegistry();
  const atoms = new AtomRegistry();
  if (handler) {
    handlers.register(handler);
    atoms.register({
      name: handler.name,
      description: "提取",
      category: handler.category,
      inputSchema: [],
      outputSchema: ["result"],
    });
  }
  return { handlers, atoms };
}

function stage(overrides: Partial<WorkflowStage> = {}): WorkflowStage {
  return { id: "s1", strategy: "chain", description: "测试阶段", ...overrides };
}

const emptyOptions = {
  handlers: new StageHandlerRegistry(),
  atoms: new AtomRegistry(),
  maxRetries: 2,
  ctx: {},
};

test("executor: atom handler 输出经主输出键合并进 state", async () => {
  const { handlers, atoms } = makeRegistry({
    name: "extract",
    category: "extract",
    execute: async () => ({ result: "提取结果", extra: 1 }),
  });
  const state: Record<string, unknown> = {};
  const outcome = await runStageOnce(stage({ atom: "extract" }), state, { ...emptyOptions, handlers, atoms });
  assert.equal(outcome.output, "提取结果");
  assert.deepEqual(state, { result: "提取结果", extra: 1, s1: "提取结果" });
});

test("executor: 未声明 atom 时回退 executor 参数", async () => {
  let calls = 0;
  const outcome = await runStageOnce(
    stage(),
    {},
    {
      ...emptyOptions,
      executor: async (s, _ctx) => {
        calls += 1;
        assert.equal(s.id, "s1");
        return "executor 产出";
      },
    },
  );
  assert.equal(outcome.output, "executor 产出");
  assert.equal(calls, 1);
});

test("executor: handler 抛错重试后成功", async () => {
  let attempts = 0;
  const { handlers, atoms } = makeRegistry({
    name: "extract",
    category: "extract",
    execute: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("第一次失败");
      return { result: "第二次成功" };
    },
  });
  const outcome = await runStageOnce(stage({ atom: "extract" }), {}, { ...emptyOptions, handlers, atoms });
  assert.equal(outcome.output, "第二次成功");
  assert.equal(outcome.retries, 1);
});

test("executor: 重试耗尽标记 degraded 前缀", async () => {
  const { handlers, atoms } = makeRegistry({
    name: "extract",
    category: "extract",
    execute: async () => {
      throw new Error("始终失败");
    },
  });
  const outcome = await runStageOnce(stage({ atom: "extract" }), {}, { ...emptyOptions, handlers, atoms });
  assert.ok(outcome.output.startsWith("[WORKFLOW_DEGRADED] s1:"), `应带 degraded 前缀，实际 ${outcome.output}`);
  assert.match(outcome.output, /始终失败/);
});

test("executor: 已批准审批门注入放行标记且空输出占位 APPROVED", async () => {
  const { handlers, atoms } = makeRegistry({
    name: "approval-gate",
    category: "gate",
    execute: async input => {
      assert.equal(input.state[APPROVAL_GRANTED_KEY], true, "批准标记应注入执行态");
      return {};
    },
  });
  const outcome = await runStageOnce(
    stage({ atom: "approval-gate" }),
    {},
    {
      ...emptyOptions,
      handlers,
      atoms,
      approvalGrants: ["s1"],
    },
  );
  assert.equal(outcome.output, "APPROVED");
});

test("executor: InterruptStageError 传播 interrupted（不标记 degraded）", async () => {
  const { handlers, atoms } = makeRegistry({
    name: "approval-gate",
    category: "gate",
    execute: async () => {
      throw new InterruptStageError("s1", "等待人工确认", { stageId: "s1" });
    },
  });
  const outcome = await runStageOnce(stage({ atom: "approval-gate" }), {}, { ...emptyOptions, handlers, atoms });
  assert.ok(outcome.interrupted, "应返回 interrupted 而非 degraded");
  assert.equal(outcome.interrupted!.stageId, "s1");
  assert.equal(outcome.output, "");
});
