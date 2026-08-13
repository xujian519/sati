import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimChartHandler } from "../../../src/patent/atoms/handlers/builtin/chart.js";
import type { StageProvider } from "../../../src/patent/atoms/handler.js";
import type { ClaimChart } from "../../../src/patent/claim-chart/protocol/types.js";
import { loadClaimChart } from "../../../src/patent/claim-chart/runtime/store.js";

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

function badChart(): unknown {
  const c = goodChart() as { elements: Array<Record<string, unknown>>; rows: unknown[] };
  c.elements[0]!.text = "包括外壳"; // 改写要素 → 校验失败
  return c;
}

function badPinChart(): unknown {
  const c = goodChart() as { elements: unknown[]; rows: Array<Record<string, unknown>> };
  c.rows[0]!.pinCite = "[D1 段[9999]]"; // 段号 9999 不在源文 → pin-cite 校验失败
  return c;
}

function badQuoteChart(): unknown {
  const c = goodChart() as { elements: unknown[]; rows: Array<Record<string, unknown>> };
  c.rows[0]!.quote = "源文中不存在的引用"; // quote 不在源文 → 引用校验失败
  return c;
}

function malformedChart(): unknown {
  // 字段级 malformed：要素缺 text + null 项、行 null + 缺 quote —— 不应崩溃，应打回重做
  return {
    elements: [{ id: "1a", claimNo: 1, kind: "limitation" }, null],
    rows: [null, { elementId: "1b", targetId: "D1", pinCite: "[D1 段[0032]]", mapping: "literal" }],
  };
}

const SOURCE_TEXT = "[0032]\n壳体与滤芯。\n[0033]\n活性炭滤芯。\n";

test("合法 chart 产出 claim_chart_doc + gap_list", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      return JSON.stringify(goodChart());
    },
  };
  const handler = new ClaimChartHandler();
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1" }]),
      chart_mode: "invalidity",
    },
    provider,
  });
  assert.equal(calls, 1);
  assert.equal(typeof state.claim_chart_doc, "string");
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart;
  assert.equal(doc.gaps.length, 1);
  assert.equal(doc.gaps[0]!.elementId, "1c");
  const gaps = JSON.parse(state.gap_list as string) as ClaimChart["gaps"];
  assert.equal(gaps.length, 1);
});

test("非法要素打回重做：第一次坏输出 + 第二次好输出 = 成功且重做 prompt 含错误", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1;
      prompts.push(prompt);
      return calls === 1 ? JSON.stringify(badChart()) : JSON.stringify(goodChart());
    },
  };
  const handler = new ClaimChartHandler();
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1" }]),
      chart_mode: "invalidity",
    },
    provider,
  });
  assert.equal(calls, 2);
  assert.ok(prompts[1]!.includes("校验失败"));
  assert.equal(typeof state.claim_chart_doc, "string");
});

test("重做超过 2 次仍失败 → 降级输出", async () => {
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify(badChart()),
  };
  const handler = new ClaimChartHandler();
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: "[]", chart_mode: "invalidity" },
    provider,
  });
  assert.equal(typeof state._error, "string");
  assert.ok((state._error as string).includes("claim-chart"));
});

test("字段级 malformed 输出（缺 text/null 项）→ 打回重做而非崩溃", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1;
      prompts.push(prompt);
      return calls === 1 ? JSON.stringify(malformedChart()) : JSON.stringify(goodChart());
    },
  };
  const handler = new ClaimChartHandler();
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: "[]", chart_mode: "invalidity" },
    provider,
  });
  assert.equal(calls, 2); // 未崩溃，进入打回重做
  assert.ok(prompts[1]!.includes("校验失败"));
  assert.equal(typeof state.claim_chart_doc, "string");
});

test("pin-cite 段号错误（sourcePath 提供）→ 打回重做 → 第二次好输出成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-src-"));
  const sourcePath = join(dir, "d1.txt");
  writeFileSync(sourcePath, SOURCE_TEXT, "utf8");
  try {
    const prompts: string[] = [];
    let calls = 0;
    const provider: StageProvider = {
      callLLM: async (prompt: string) => {
        calls += 1;
        prompts.push(prompt);
        return calls === 1 ? JSON.stringify(badPinChart()) : JSON.stringify(goodChart());
      },
    };
    const handler = new ClaimChartHandler();
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1", sourcePath }]),
        chart_mode: "invalidity",
      },
      provider,
    });
    assert.equal(calls, 2);
    assert.ok(prompts[1]!.includes("段号"));
    assert.equal(typeof state.claim_chart_doc, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote 不在源文（sourcePath 提供）→ 打回重做 → 第二次好输出成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-src-"));
  const sourcePath = join(dir, "d1.txt");
  writeFileSync(sourcePath, SOURCE_TEXT, "utf8");
  try {
    const prompts: string[] = [];
    let calls = 0;
    const provider: StageProvider = {
      callLLM: async (prompt: string) => {
        calls += 1;
        prompts.push(prompt);
        return calls === 1 ? JSON.stringify(badQuoteChart()) : JSON.stringify(goodChart());
      },
    };
    const handler = new ClaimChartHandler();
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1", sourcePath }]),
        chart_mode: "invalidity",
      },
      provider,
    });
    assert.equal(calls, 2);
    assert.ok(prompts[1]!.includes("引用文本在源文中不存在"));
    assert.equal(typeof state.claim_chart_doc, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sourcePath 文件不存在 → 错误消息含目标路径（重做超限降级）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-src-"));
  const sourcePath = join(dir, "missing.txt"); // 不存在
  try {
    const provider: StageProvider = {
      callLLM: async () => JSON.stringify(goodChart()),
    };
    const handler = new ClaimChartHandler();
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1", sourcePath }]),
        chart_mode: "invalidity",
      },
      provider,
    });
    assert.equal(typeof state._error, "string");
    assert.ok((state._error as string).includes(sourcePath)); // 降级错误含目标路径
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caseId 提供时落盘 json，verified 行在重跑时保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-atom-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const caseId = "case-1";
    const handler = new ClaimChartHandler();
    // 第一次运行：caseId 提供 → 落盘
    const p1: StageProvider = { caseId, callLLM: async () => JSON.stringify(goodChart()) };
    await handler.execute({
      state: { claim: CLAIM, chart_targets: "[]", chart_mode: "invalidity" },
      provider: p1,
    });
    // 人工核验第 1 行（1a→D1）
    const saved = loadClaimChart(caseId, "chart-1");
    assert.ok(saved);
    saved!.rows[0]!.verified = true;
    const { saveClaimChart } = await import("../../../src/patent/claim-chart/runtime/store.js");
    saveClaimChart(saved!, caseId);
    const again = loadClaimChart(caseId, "chart-1");
    assert.equal(again?.rows[0]?.verified, true); // verified 行可持久化往返
    // 第二次运行 handler（同 caseId）：loadClaimChart 合并 verified —— 已验证行保留、未验证行仍 false
    const p2: StageProvider = { caseId, callLLM: async () => JSON.stringify(goodChart()) };
    await handler.execute({
      state: { claim: CLAIM, chart_targets: "[]", chart_mode: "invalidity" },
      provider: p2,
    });
    const merged = loadClaimChart(caseId, "chart-1");
    assert.equal(merged?.rows[0]?.verified, true); // 1a→D1 核验标记重跑保留
    assert.equal(merged?.rows[1]?.verified, false); // 1b→D1 未核验仍 false
    assert.equal(merged?.rows[2]?.verified, false);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
