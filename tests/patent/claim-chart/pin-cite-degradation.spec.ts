import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimChartHandler } from "../../../src/patent/atoms/handlers/builtin/chart.js";
import type { StageProvider } from "../../../src/patent/atoms/handler.js";
import type { ClaimChart } from "../../../src/patent/claim-chart/protocol/types.js";
import { renderChartMarkdown } from "../../../src/patent/claim-chart/runtime/store.js";

const CLAIM = "1. 一种过滤装置，包括壳体和滤芯，所述滤芯含有活性炭。";

function chartOutput(): unknown {
  return {
    elements: [
      { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" },
      { id: "1b", claimNo: 1, text: "和滤芯", kind: "limitation" },
      { id: "1c", claimNo: 1, text: "所述滤芯含有活性炭", kind: "limitation" },
    ],
    rows: [
      { elementId: "1a", targetId: "D1", quote: "壳体", pinCite: "[D1 段[0032]]", mapping: "literal" },
      { elementId: "1b", targetId: "D1", quote: "滤芯", pinCite: "[D1 段[0032]]", mapping: "literal" },
      { elementId: "1c", targetId: "D1", quote: "活性炭", pinCite: "[D1 段[0033]]", mapping: "literal" },
    ],
  };
}

async function run(targets: unknown[]): Promise<ClaimChart> {
  const provider: StageProvider = { callLLM: async () => JSON.stringify(chartOutput()) };
  const state = await new ClaimChartHandler().execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify(targets),
      chart_mode: "invalidity",
    },
    provider,
  });
  assert.equal(typeof state.claim_chart_doc, "string");
  return JSON.parse(state.claim_chart_doc as string) as ClaimChart;
}

test("sourcePath 缺失 → 行 note 与报告标注「未做原文核验」", async () => {
  const chart = await run([{ id: "D1", kind: "prior-art", title: "对比文件1" }]);

  assert.equal(chart.targets[0]!.sourcePath, undefined);
  for (const row of chart.rows) {
    assert.match(row.note ?? "", /未做原文核验/);
  }

  const md = renderChartMarkdown(chart);
  assert.match(md, /未做原文核验：D1（未提供源文路径，pin-cite 仅做格式校验）/);
  // 行级标注在表格 Note 列可见（不是只躺在 JSON 里）
  const row1a = md.split("\n").find(line => line.startsWith("| 1a |"));
  assert.ok(row1a);
  assert.match(row1a!, /未做原文核验/);
});

test("sourcePath 可读时不标注降级（核验面完整）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-pin-degrade-"));
  const sourcePath = join(dir, "d1.txt");
  writeFileSync(sourcePath, "[0032]\n壳体与滤芯。\n[0033]\n活性炭滤芯。\n", "utf8");
  try {
    const chart = await run([{ id: "D1", kind: "prior-art", title: "对比文件1", sourcePath }]);
    for (const row of chart.rows) {
      assert.equal(row.note, undefined);
    }
    const md = renderChartMarkdown(chart);
    assert.ok(!md.includes("未做原文核验"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
