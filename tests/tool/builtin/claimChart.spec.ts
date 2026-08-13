import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimChartBuild, createClaimChartTool, type ClaimChartInput } from "../../../src/tool/builtin/claimChart.js";
import { makeToolContext } from "../context-fixture.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import type { SatiToolModelClient } from "../../../src/tool/protocol/types.js";

function textDelta(text: string): CanonicalModelEvent {
  return { type: "text_delta", text } as CanonicalModelEvent;
}

/** 按 prompt 内容分发响应的 mock model（对齐 patentWorkflowRun.spec.ts 模式）。 */
function mockModel(respond: (prompt: string) => string): SatiToolModelClient {
  return {
    async *stream(request: CanonicalModelRequest) {
      const prompt = request.messages[0]?.content?.[0]?.type === "text" ? request.messages[0].content[0].text : "";
      yield textDelta(respond(prompt));
    },
  };
}

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

test("createClaimChartTool.execute：mockModel 全流程 → content 摘要 + data.chart + 落盘路径透出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-tool-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const tool = createClaimChartTool();
    const res = await tool.execute(
      {
        mode: "invalidity",
        claim_text: CLAIM,
        targets: [{ id: "D1", kind: "prior-art", title: "对比文件1" }],
        case_id: "case-1",
      },
      makeToolContext({ model: mockModel(() => JSON.stringify(goodChart())) }),
    );
    assert.equal(res.metadata?.error, undefined);
    assert.equal(res.data?.chart.rows.length, 3);
    assert.equal(res.data?.gap_count, 1);
    assert.ok(res.data?.json_path?.endsWith("claim-chart-chart-1.json"));
    assert.ok(res.data?.md_path?.endsWith("claim-chart-chart-1.md"));
    // content 摘要：json 条目含 gap_count/gaps；text 条目含落盘路径
    const jsonEntry = res.content.find(c => c.type === "json");
    assert.ok(jsonEntry && jsonEntry.type === "json");
    const summary = jsonEntry.value as { gap_count?: number; gaps?: unknown[] };
    assert.equal(summary.gap_count, 1);
    assert.equal(summary.gaps?.length, 1);
    const textEntry = res.content.find(c => c.type === "text" && c.text.includes("落盘"));
    assert.ok(textEntry && textEntry.type === "text");
    assert.ok(textEntry.text.includes(".json"));
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createClaimChartTool.execute：无 model 客户端时返回失败路径", async () => {
  const tool = createClaimChartTool();
  const res = await tool.execute({ mode: "invalidity", claim_text: CLAIM, targets: [] }, makeToolContext());
  assert.equal(res.metadata?.error, "claim_chart_build_failed");
  const text = res.content.find(c => c.type === "text");
  assert.ok(text && text.type === "text" && text.text.includes("失败"));
});
