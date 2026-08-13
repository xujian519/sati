import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClaimChart, renderChartMarkdown, saveClaimChart } from "../../../src/patent/claim-chart/runtime/store.js";
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

test("save/load 往返一致（落盘 data/cases/<caseId>/outputs/）", () => {
  const prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "cc-store-"));
  process.chdir(dir);
  try {
    const chart = makeChart();
    const { jsonPath, mdPath } = saveClaimChart(chart, chart.caseId);
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
