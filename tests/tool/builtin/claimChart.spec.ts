import assert from "node:assert/strict";
import test from "node:test";
import { claimChartBuild, type ClaimChartInput } from "../../../src/tool/builtin/claimChart.js";

const CLAIM = "1. 一种过滤装置，包括壳体和滤芯，所述滤芯含有活性炭。";

function goodChart(): unknown {
  return {
    elements: [
      { id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" },
      { id: "1b", claimNo: 1, text: "和滤芯", kind: "limitation" },
      { id: "1c", claimNo: 1, text: "所述滤芯含有活性炭", kind: "limitation" },
    ],
    rows: [
      { elementId: "1a", targetId: "D1", quote: "壳体", pinCite: "[D1 段[0032]]", mapping: "literal" },
      { elementId: "1b", targetId: "D1", quote: "滤芯", pinCite: "[D1 段[0032]]", mapping: "literal" },
      { elementId: "1c", targetId: "D1", quote: "", pinCite: "[D1 段[0032]]", mapping: "not-found" },
    ],
  };
}

test("claimChartBuild 纯函数入口：mock LLM → 产出 chart + gaps", async () => {
  const input: ClaimChartInput = {
    mode: "invalidity",
    claim_text: CLAIM,
    targets: [{ id: "D1", kind: "prior-art", title: "对比文件1" }],
  };
  const result = await claimChartBuild(input, {
    callLLM: async () => JSON.stringify(goodChart()),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.chart.gaps.length, 1);
    assert.equal(result.chart.gaps[0]!.elementId, "1c");
    assert.equal(result.chart.rows.length, 3);
  }
});

test("无 callLLM 时返回明确错误", async () => {
  const result = await claimChartBuild({ mode: "invalidity", claim_text: CLAIM, targets: [] }, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("未配置 LLM"));
});

test("claims 为空返回错误", async () => {
  const result = await claimChartBuild(
    { mode: "invalidity", claim_text: "", targets: [] },
    { callLLM: async () => "{}" },
  );
  assert.equal(result.ok, false);
});
