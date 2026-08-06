/**
 * search_patent_figure 工具集成测试。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { saveFigureIndex, type FigureIndexEntry } from "../../../src/patent/figure/index-store.js";
import type { FigureAnalysisResult } from "../../../src/patent/figure/types.js";
import { createSearchPatentFigureTool } from "../../../src/tool/builtin/searchPatentFigure.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function makeEntry(imagePath: string, figureNumber: number, componentNames: string[], usable = true): FigureIndexEntry {
  const analysis: FigureAnalysisResult = {
    imagePath,
    figureNumber,
    figureType: "structure",
    overallDescription: componentNames.join("、") + "组成的结构",
    components: componentNames.map((name, index) => ({
      refNumber: String(index + 1),
      name,
      kind: "mechanical",
      description: `${name}部件`,
    })),
    connections: [],
    figureDescription: `图${figureNumber}是结构示意图；图中：${componentNames.map((n, i) => `${i + 1}-${n}`).join("；")}；`,
    confidence: usable ? 0.9 : 0.4,
    warnings: usable ? [] : ["组件识别失败"],
    usable,
    modelUsed: "moonshot/kimi-k3",
  };
  return { imagePath, analyzedAt: "2026-08-06T00:00:00.000Z", analysis };
}

async function tmpWorkspace(): Promise<{ dir: string; cwd: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-figure-search-"));
  const cwd = path.join(dir, "case");
  await import("node:fs/promises").then(m => m.mkdir(cwd, { recursive: true }));
  return { dir, cwd };
}

function baseContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("search_patent_figure: 工具元数据（只读/并发安全/域）", () => {
  const tool = createSearchPatentFigureTool();
  assert.equal(tool.name, "search_patent_figure");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.isReadOnly({ query: "壳体" }), true);
  assert.equal(tool.isConcurrencySafe({ query: "壳体" }), true);
});

test("search_patent_figure: 空索引返回引导提示", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    const tool = createSearchPatentFigureTool();
    const result = await tool.execute({ query: "缓冲层" }, baseContext(cwd));
    const output = result.data as { total: number; indexedCount: number; hint?: string; results: unknown[] };
    assert.equal(output.total, 0);
    assert.equal(output.indexedCount, 0);
    assert.ok(output.hint?.includes("analyze_patent_figure"), "应提示先分析附图");
    const first = result.content[0];
    assert.equal(first?.type, "json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_patent_figure: 关键词命中返回排序结果与组件", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    await saveFigureIndex(path.join(cwd, ".sati", "figures-index.json"), [
      makeEntry("figures/图2.png", 2, ["壳体"]),
      makeEntry("figures/图1.png", 1, ["缓冲层"]),
    ]);
    const tool = createSearchPatentFigureTool();
    const result = await tool.execute({ query: "缓冲层" }, baseContext(cwd));
    const output = result.data as {
      total: number;
      indexedCount: number;
      method: string;
      results: Array<{ figureNumber: number; score: number; components: unknown[]; imagePath: string }>;
    };
    // 图2 壳体与"缓冲层"无词元重叠 → 零分过滤，仅返回图1
    assert.equal(output.total, 1);
    assert.equal(output.indexedCount, 2);
    assert.equal(output.method, "keyword");
    assert.equal(output.results[0]?.figureNumber, 1);
    assert.ok((output.results[0]?.score ?? 0) > 0);
    assert.equal(output.results[0]?.components.length, 1);
    assert.equal(output.results[0]?.imagePath, "figures/图1.png");
    assert.equal(result.metadata?.method, "keyword");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_patent_figure: limit 上限 10", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeEntry(`figures/图${index + 1}.png`, index + 1, ["壳体"]),
    );
    await saveFigureIndex(path.join(cwd, ".sati", "figures-index.json"), entries);
    const tool = createSearchPatentFigureTool();
    const result = await tool.execute({ query: "壳体", limit: 50 }, baseContext(cwd));
    const output = result.data as { total: number; results: unknown[] };
    assert.equal(output.results.length, 10);
    assert.equal(output.total, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_patent_figure: 空查询 → 列表模式按附图编号排序", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    await saveFigureIndex(path.join(cwd, ".sati", "figures-index.json"), [
      makeEntry("figures/图2.png", 2, ["壳体"]),
      makeEntry("figures/图1.png", 1, ["缓冲层"], false),
    ]);
    const tool = createSearchPatentFigureTool();
    const result = await tool.execute({ query: "" }, baseContext(cwd));
    const output = result.data as {
      results: Array<{ figureNumber: number; score: number; usable: boolean }>;
    };
    assert.deepEqual(
      output.results.map(item => item.figureNumber),
      [1, 2],
    );
    // 不可用条目（列表模式）得分 0.5，可用得分 1
    assert.equal(output.results[0]?.score, 0.5);
    assert.equal(output.results[1]?.score, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_patent_figure: 无匹配返回引导提示", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    await saveFigureIndex(path.join(cwd, ".sati", "figures-index.json"), [makeEntry("figures/图1.png", 1, ["缓冲层"])]);
    const tool = createSearchPatentFigureTool();
    const result = await tool.execute({ query: "半导体晶圆" }, baseContext(cwd));
    const output = result.data as { total: number; hint?: string };
    assert.equal(output.total, 0);
    assert.ok(output.hint?.includes("未检索到"), "应提示无匹配");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_patent_figure: 注入 embedding 客户端 → 混合检索生效", async () => {
  const { dir, cwd } = await tmpWorkspace();
  try {
    await saveFigureIndex(path.join(cwd, ".sati", "figures-index.json"), [
      makeEntry("figures/图1.png", 1, ["散热鳍片"]),
      makeEntry("figures/图2.png", 2, ["外壳"]),
    ]);
    const embedding = {
      dimensions: 4,
      healthCheck: async () => true,
      async embed(texts: string[]): Promise<number[][]> {
        // query + 2 docs：图1 与 query 高度对齐
        return texts.map((_, index) =>
          index === 0 ? [1, 0, 0, 0] : index === 1 ? [0.9, 0.1, 0, 0] : [0.2, 0.8, 0, 0],
        );
      },
    };
    const tool = createSearchPatentFigureTool({ embeddingClient: embedding });
    const result = await tool.execute({ query: "散热" }, baseContext(cwd));
    const output = result.data as { method: string; results: Array<{ figureNumber: number }> };
    assert.equal(output.method, "hybrid");
    assert.equal(output.results[0]?.figureNumber, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
