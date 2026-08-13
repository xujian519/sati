import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chartFileBase,
  loadClaimChart,
  renderChartMarkdown,
  saveClaimChart,
} from "../../../src/patent/claim-chart/runtime/store.js";
import { DRAFT_NOTICE } from "../../../src/patent/claim-chart/protocol/types.js";
import type { ClaimChart } from "../../../src/patent/claim-chart/protocol/types.js";

function makeChart(): ClaimChart {
  return {
    chartId: "t1",
    mode: "invalidity",
    caseId: "case-1",
    elements: [
      { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" },
      { id: "1b", claimNo: 1, text: "和滤芯", kind: "limitation" },
    ],
    claimNos: [1],
    targets: [{ id: "D1", kind: "prior-art" }],
    rows: [
      {
        elementId: "1a",
        targetId: "D1",
        quote: "壳体",
        pinCite: "[D1 段[0032]]",
        mapping: "literal",
        state: "literal",
        verified: false,
      },
      {
        elementId: "1b",
        targetId: "D1",
        quote: "",
        pinCite: "[D1 段[0032]]",
        mapping: "not-found",
        state: "not-found",
        verified: false,
      },
    ],
    gaps: [
      { elementId: "1b", targetId: "D1", mapping: "not-found", reason: "未找到", suggestion: "补充检索或论证等同替换" },
    ],
    draftNotice: DRAFT_NOTICE,
  };
}

test("renderChartMarkdown 含免责声明/gap list/表格", () => {
  const md = renderChartMarkdown(makeChart());
  assert.ok(md.startsWith("# 权利要求对照表"));
  assert.ok(md.includes(DRAFT_NOTICE));
  assert.ok(md.includes("## Gap List"));
  assert.ok(md.includes("1b"));
  assert.ok(md.includes("| # |"));
  assert.ok(md.includes("包括壳体"));
});

test("renderChartMarkdown 空 gap/特殊字符转义/verified 标记/分隔行", () => {
  const chart = makeChart();
  chart.gaps = [];
  chart.elements.push({ id: "1c", claimNo: 1, text: "包括|隔板\n和滤网", kind: "limitation" });
  chart.rows.push({
    elementId: "1c",
    targetId: "D1",
    quote: "壳体\n外壳",
    pinCite: "[D1 段[0033]|图1]",
    mapping: "literal",
    state: "literal",
    verified: true,
  });
  const md = renderChartMarkdown(chart);

  // ① gap 为空分支：提示语渲染、无 checklist 项
  assert.ok(md.includes("（无缺口：全部要素均有证据映射）"));
  assert.ok(!md.includes("- [ ]"));

  // ④ 表格分隔行
  assert.ok(md.includes("|---|---|---|---|---|---|"));

  // ②/③ 1c 行：| 转义为 \|、换行替换为空格、pinCite 内 | 转义、verified:true 渲染 ✓
  const row1c = md.split("\n").find(line => line.includes("| 1c |"));
  assert.ok(row1c, "应存在 1c 表格行");
  assert.ok(row1c!.startsWith("| 1c |"));
  assert.ok(row1c!.includes("包括\\|隔板 和滤网"));
  assert.ok(row1c!.includes("壳体 外壳"));
  assert.ok(row1c!.includes("[D1 段[0033]\\|图1]"));
  assert.ok(row1c!.endsWith("| ✓ |"));
  // 无转义列的 mapping/verified 断言不涉及 | 字符的额外列数污染
  assert.ok(!row1c!.includes("| ☐ |"));
});

test("chartFileBase 拒绝不安全 chartId（防路径注入）", () => {
  for (const bad of ["../evil", "a/b", ".hidden", "a b"]) {
    assert.throws(
      () => chartFileBase("case-1", bad),
      { name: "RangeError", message: /^Invalid chartId / },
      `chartId ${JSON.stringify(bad)} 应被拒绝`,
    );
  }
  assert.doesNotThrow(() => chartFileBase("case-1", "t1"));
  assert.doesNotThrow(() => chartFileBase("case-1", "a.b_c-1"));
});

test("save/load 往返一致（落盘 data/cases/<caseId>/outputs/）", async () => {
  const prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "cc-store-"));
  process.chdir(dir);
  try {
    const chart = makeChart();
    const { jsonPath, mdPath } = await saveClaimChart(chart, chart.caseId);
    assert.ok(jsonPath.includes(join("data", "cases", "case-1", "outputs")));
    assert.ok(readFileSync(mdPath, "utf8").length > 0);
    const loaded = loadClaimChart(chart.caseId, chart.chartId);
    assert.equal(loaded?.chartId, "t1");
    assert.deepEqual(loaded?.rows, chart.rows);
    assert.equal(loadClaimChart(chart.caseId, "missing"), null);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
