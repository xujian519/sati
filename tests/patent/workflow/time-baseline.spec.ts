import assert from "node:assert/strict";
import test from "node:test";
import {
  TimeBaselineHandler,
  globalAtomRegistry,
  registerBuiltinAtoms,
  type PipelineState,
} from "../../../src/patent/atoms/index.js";
import { patentInventivenessManifest, runWorkflow, validateWorkflowManifest } from "../../../src/patent/index.js";

/**
 * time-baseline 确定性原子（#735 S-05）：
 * 优先权日 > 申请日；日期归一复用 evidence/date.ts（月级→月末）；
 * 缺两者时显式 degraded + 明示「未确定截止日」，不得假定今天。
 */

async function run(state: PipelineState): Promise<PipelineState> {
  return new TimeBaselineHandler().execute({ state });
}

function baselineOf(state: PipelineState): {
  cutoffDate: string;
  basis: string;
  degraded: boolean;
  note?: string;
} {
  return JSON.parse(String(state.time_baseline)) as {
    cutoffDate: string;
    basis: string;
    degraded: boolean;
    note?: string;
  };
}

test("time-baseline: 优先权日优先于申请日", async () => {
  const out = await run({ priority_date: "2023-05-01", filing_date: "2024-01-01" });
  assert.equal(out.cutoff_date, "2023-05-01");
  assert.equal(out.cutoff_basis, "priority");
  assert.equal(out.cutoff_degraded, false);
  assert.deepEqual(baselineOf(out), { cutoffDate: "2023-05-01", basis: "priority", degraded: false });
});

test("time-baseline: 仅申请日 → basis=filing", async () => {
  const out = await run({ filing_date: "2024-01-01" });
  assert.equal(out.cutoff_date, "2024-01-01");
  assert.equal(out.cutoff_basis, "filing");
  assert.equal(out.cutoff_degraded, false);
});

test("time-baseline: 月级日期推定月末（复用证据日期规则）", async () => {
  const out = await run({ filing_date: "2024-02" });
  assert.equal(out.cutoff_date, "2024-02-29", "闰年 2 月应推定到 2 月 29 日");
  assert.equal(out.cutoff_basis, "filing");
});

test("time-baseline: 缺申请日/优先权日 → 显式降级，不假定今天", async () => {
  const out = await run({});
  assert.equal(out.cutoff_date, "");
  assert.equal(out.cutoff_basis, "unknown");
  assert.equal(out.cutoff_degraded, true);
  const baseline = baselineOf(out);
  assert.equal(baseline.degraded, true);
  assert.match(baseline.note ?? "", /未确定截止日/);
  assert.match(baseline.note ?? "", /不得假定今天/);
});

test("time-baseline: 非法优先权日回退到有效申请日（不因单个坏值整体降级）", async () => {
  const out = await run({ priority_date: "2023-02-30", filing_date: "2024-01-01" });
  assert.equal(out.cutoff_date, "2024-01-01");
  assert.equal(out.cutoff_basis, "filing");
});

test("time-baseline: 读取 inventiveness_parse JSON 中的时间字段", async () => {
  const out = await run({
    inventiveness_parse: JSON.stringify({
      features: ["传送带"],
      field: "机械分拣",
      priority_date: "2022-11-15",
      filing_date: "2023-03-01",
    }),
  });
  assert.equal(out.cutoff_date, "2022-11-15");
  assert.equal(out.cutoff_basis, "priority");
});

test("time-baseline: 显式 state 键优先于 parse JSON", async () => {
  const out = await run({
    filing_date: "2025-01-01",
    inventiveness_parse: JSON.stringify({ filing_date: "2020-01-01" }),
  });
  assert.equal(out.cutoff_date, "2025-01-01");
  assert.equal(out.cutoff_basis, "filing");
});

test("time-baseline: 原子已注册进全局注册表", () => {
  registerBuiltinAtoms();
  const atom = globalAtomRegistry.lookup("time-baseline");
  assert.ok(atom);
  assert.deepEqual(atom.outputSchema, ["time_baseline", "cutoff_date", "cutoff_basis", "cutoff_degraded"]);
});

test("patent_inventiveness_v1：time_baseline 紧接 parse 且声明 time-baseline 原子", () => {
  validateWorkflowManifest(patentInventivenessManifest);
  const ids = patentInventivenessManifest.stages.map(stage => stage.id);
  assert.equal(ids[0], "parse");
  assert.equal(ids[1], "time_baseline");
  assert.equal(ids[2], "search");
  const stage = patentInventivenessManifest.stages[1]!;
  assert.equal(stage.atom, "time-baseline");
});

test("runWorkflow：time_baseline 阶段从 ctx 读取日期并产出截止日事实", async () => {
  registerBuiltinAtoms();
  const result = await runWorkflow(
    {
      id: "time_baseline_wf",
      name: "时间基准",
      caseType: "test",
      stages: [{ id: "time_baseline", strategy: "chain", description: "时间基准", atom: "time-baseline" }],
    },
    { input: "x", priority_date: "2021-07-01", filing_date: "2022-01-01" },
  );
  assert.equal(result.completed, true);
  assert.equal(result.stages[0]!.output.includes('"basis":"priority"'), true);
});
