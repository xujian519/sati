import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../context-fixture.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import type { SatiToolModelClient } from "../../../src/tool/protocol/types.js";
import type { StageProvider } from "../../../src/patent/atoms/index.js";
import { registerBuiltinAtoms } from "../../../src/patent/atoms/index.js";
import {
  createFlexiblePlanTool,
  type FlexiblePlanStageInput,
} from "../../../src/tool/builtin/patentFlexiblePlanTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

/**
 * flexible_plan（灵活计划：创建 → 原子执行 → 逐阶段确认/回退）接线测试。
 *
 * mock model 按 prompt 返回 extract 原子的结构化输出；mock search 返回固定
 * 现有技术命中。计划经默认 JsonFileFlexiblePlanStore 持久化到临时目录，
 * 验证 create → run → confirm 的跨调用状态流与 fail-closed 守卫。
 */

function textDelta(text: string): CanonicalModelEvent {
  return { type: "text_delta", text } as CanonicalModelEvent;
}

function mockModel(respond: (prompt: string) => string): SatiToolModelClient {
  return {
    async *stream(request: CanonicalModelRequest) {
      const prompt = request.messages[0]?.content?.[0]?.type === "text" ? request.messages[0].content[0].text : "";
      yield textDelta(respond(prompt));
    },
  };
}

const extractResponder = (prompt: string): string => {
  if (prompt.includes("提取技术特征")) {
    return JSON.stringify({ features: ["杯体双层真空结构"], problems: [], effects: [] });
  }
  return "{}";
};

const mockSearch: StageProvider["search"] = async (_query, _opts) => [
  { title: "D1", snippet: "双层真空保温杯", url: "https://example.com/D1" },
];

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => (c.type === "text" && c.text ? c.text : "")).join("");
}

const PLAN_STAGES: FlexiblePlanStageInput[] = [
  {
    id: "extract_features",
    name: "提取技术特征",
    goal: "从交底书提取技术特征",
    strategy: "sub_agent",
    atom: "extract",
    params: { extraction_type: "提取技术特征", output_key: "features" },
  },
  {
    id: "report",
    name: "撰写报告",
    goal: "汇总披露分析报告",
    strategy: "chain",
  },
];

async function withTempDir(fn: (ctx: ReturnType<typeof makeToolContext>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flexible-plan-tool-"));
  try {
    await fn(makeToolContext({ cwd: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create 后 get 往返（跨调用持久化）", async () => {
  await withTempDir(async ctx => {
    const tool = createFlexiblePlanTool();
    const created = await tool.execute(
      {
        action: "create",
        caseId: "fp-1",
        caseType: "disclosure_analysis",
        stages: PLAN_STAGES,
        inputText: "交底书原文",
      },
      ctx,
    );
    const createdText = textOf(created);
    assert.match(createdText, /caseId=fp-1/);
    assert.match(createdText, /status=active/);
    assert.match(createdText, /extract_features \[atom:extract\]/);
    assert.match(createdText, /已创建并持久化/);

    // 跨调用：新工具实例（独立 deps）仍能按 caseId 读回。
    const other = createFlexiblePlanTool();
    const got = await other.execute({ action: "get", caseId: "fp-1" }, ctx);
    const gotText = textOf(got);
    assert.match(gotText, /caseId=fp-1/);
    assert.match(gotText, /report/);
  });
});

test("create 缺 caseType / 缺 caseId fail-closed 返回文本而非抛错", async () => {
  await withTempDir(async ctx => {
    const tool = createFlexiblePlanTool();
    const noCaseType = await tool.execute({ action: "create", caseId: "fp-2" }, ctx);
    assert.match(textOf(noCaseType), /create 需要 caseType/);
    const noCaseId = await tool.execute({ action: "get" }, ctx);
    assert.match(textOf(noCaseId), /caseId 不能为空/);
    const unknown = await tool.execute({ action: "fly" as never, caseId: "fp-2" }, ctx);
    assert.match(textOf(unknown), /未知操作/);
  });
});

test("run 原子执行未确认阶段，autoConfirm 固化后再次 run 不再重复执行", async () => {
  await withTempDir(async ctx => {
    registerBuiltinAtoms();
    const tool = createFlexiblePlanTool({ model: mockModel(extractResponder), search: mockSearch });
    await tool.execute(
      {
        action: "create",
        caseId: "fp-3",
        caseType: "disclosure_analysis",
        stages: PLAN_STAGES,
        inputText: "保温杯交底书",
      },
      ctx,
    );

    const run1 = await tool.execute({ action: "run", caseId: "fp-3", autoConfirm: true }, ctx);
    const run1Text = textOf(run1);
    assert.match(run1Text, /extract_features \[atom:extract\]/);
    assert.match(run1Text, /双层真空结构/, "extract 原子应产出 LLM 结果");
    assert.match(run1Text, /report/, "无 atom 阶段透传执行");
    assert.match(run1Text, /完成状态: completed/);

    // autoConfirm 后：全部阶段 confirmed，再次 run 应拒绝（无待执行阶段）。
    const run2 = await tool.execute({ action: "run", caseId: "fp-3" }, ctx);
    assert.match(textOf(run2), /没有待执行阶段/);

    // 状态已固化：get 显示 confirmed。
    const got = await tool.execute({ action: "get", caseId: "fp-3" }, ctx);
    assert.match(textOf(got), /✅ extract_features/);
    assert.match(textOf(got), /✅ report/);
  });
});

test("confirm 固化后 run 只执行未确认阶段", async () => {
  await withTempDir(async ctx => {
    registerBuiltinAtoms();
    const tool = createFlexiblePlanTool({ model: mockModel(extractResponder), search: mockSearch });
    await tool.execute(
      {
        action: "create",
        caseId: "fp-4",
        caseType: "disclosure_analysis",
        stages: PLAN_STAGES,
        inputText: "保温杯交底书",
      },
      ctx,
    );

    // 手动确认 extract_features（不跑 run）。
    const confirmed = await tool.execute({ action: "confirm", caseId: "fp-4", stageId: "extract_features" }, ctx);
    assert.match(textOf(confirmed), /已确认阶段 "extract_features"/);

    // run：只执行未确认的 report；extract_features 不重复执行。
    const run = await tool.execute({ action: "run", caseId: "fp-4" }, ctx);
    const runText = textOf(run);
    assert.doesNotMatch(runText, /extract_features/, "已确认阶段不应再次执行");
    assert.match(runText, /report/);
  });
});

test("rollback 回退：已确认阶段置 rolled_back，currentStageId 回到目标", async () => {
  await withTempDir(async ctx => {
    const tool = createFlexiblePlanTool();
    await tool.execute({ action: "create", caseId: "fp-5", caseType: "disclosure_analysis", stages: PLAN_STAGES }, ctx);
    await tool.execute({ action: "confirm", caseId: "fp-5", stageId: "extract_features" }, ctx);
    await tool.execute({ action: "confirm", caseId: "fp-5", stageId: "report" }, ctx);

    const rolled = await tool.execute({ action: "rollback", caseId: "fp-5", stageId: "extract_features" }, ctx);
    const rolledText = textOf(rolled);
    assert.match(rolledText, /已回退到阶段 "extract_features"/);
    assert.match(rolledText, /↩️ extract_features/, "目标阶段及后续已确认阶段置 rolled_back");
    assert.match(rolledText, /↩️ report/);
    assert.match(rolledText, /当前阶段: extract_features/);
  });
});

test("add / remove / reorder 运行时增删改阶段", async () => {
  await withTempDir(async ctx => {
    const tool = createFlexiblePlanTool();
    await tool.execute({ action: "create", caseId: "fp-6", caseType: "disclosure_analysis", stages: PLAN_STAGES }, ctx);

    const added = await tool.execute(
      { action: "add", caseId: "fp-6", stage: { id: "extra", name: "附加检查", goal: "补充检查", strategy: "chain" } },
      ctx,
    );
    assert.match(textOf(added), /已追加阶段 "extra"/);

    const reordered = await tool.execute(
      { action: "reorder", caseId: "fp-6", stageIds: ["extra", "extract_features", "report"] },
      ctx,
    );
    const reorderedText = textOf(reordered);
    const extraIdx = reorderedText.indexOf("- ⏳ extra");
    const extractIdx = reorderedText.indexOf("- ⏳ extract_features");
    assert.ok(extraIdx !== -1 && extractIdx !== -1 && extraIdx < extractIdx, "extra 应排在首位");

    const removed = await tool.execute({ action: "remove", caseId: "fp-6", stageId: "extra" }, ctx);
    const removedText = textOf(removed);
    assert.doesNotMatch(removedText, /- ⏳ extra\b/, "阶段列表不应再含 extra");
    assert.match(removedText, /已删除阶段 "extra"/);
  });
});

test("complete / abandon 收尾（abandon 缺 reason fail-closed）", async () => {
  await withTempDir(async ctx => {
    const tool = createFlexiblePlanTool();
    await tool.execute({ action: "create", caseId: "fp-7", caseType: "disclosure_analysis", stages: PLAN_STAGES }, ctx);

    const noReason = await tool.execute({ action: "abandon", caseId: "fp-7" }, ctx);
    assert.match(textOf(noReason), /abandon 需要 reason/);

    const abandoned = await tool.execute({ action: "abandon", caseId: "fp-7", reason: "客户撤回" }, ctx);
    assert.match(textOf(abandoned), /status=abandoned/);
    assert.match(textOf(abandoned), /↩️ extract_features/, "pending 阶段置 rolled_back 保留审计");

    // abandoned 计划不可再变更（fail-closed）。
    const confirmAfterAbandon = await tool.execute({ action: "confirm", caseId: "fp-7", stageId: "report" }, ctx);
    assert.match(textOf(confirmAfterAbandon), /仅 active 可变更/);

    // complete 路径：新计划全确认 → completed。
    await tool.execute({ action: "create", caseId: "fp-8", caseType: "disclosure_analysis", stages: PLAN_STAGES }, ctx);
    const completed = await tool.execute({ action: "complete", caseId: "fp-8" }, ctx);
    assert.match(textOf(completed), /status=completed/);
  });
});

test("持久化文件落盘到 <caseDir>/workflow-runs/flexible-plans/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flexible-plan-tool-"));
  try {
    const ctx = makeToolContext({ cwd: dir });
    const tool = createFlexiblePlanTool();
    await tool.execute({ action: "create", caseId: "fp-9", caseType: "disclosure_analysis", stages: PLAN_STAGES }, ctx);
    const saved = await readFile(join(dir, "data/cases/fp-9/workflow-runs/flexible-plans/fp-9.json"), "utf8");
    assert.match(saved, /"caseId": "fp-9"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createBuiltinRegistry 注册 flexible_plan（domain: patent）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("flexible_plan");
  assert.ok(tool, "flexible_plan 应已注册");
  assert.equal(tool.domain, "patent");
});
