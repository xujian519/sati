/**
 * 附图索引存储（index-store）单元测试。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FIGURE_INDEX_VERSION,
  loadFigureIndex,
  saveFigureIndex,
  upsertFigureIndex,
  type FigureIndexEntry,
} from "../../../src/patent/figure/index-store.js";
import type { FigureAnalysisResult } from "../../../src/patent/figure/types.js";

function makeEntry(imagePath: string, figureNumber: number, name = "壳体"): FigureIndexEntry {
  const analysis: FigureAnalysisResult = {
    imagePath,
    figureNumber,
    figureType: "structure",
    overallDescription: "整体结构示意",
    components: [{ refNumber: String(figureNumber), name, kind: "mechanical", description: `${name}部件` }],
    connections: [],
    figureDescription: `图${figureNumber}是结构示意图；图中：${figureNumber}-${name}；`,
    confidence: 0.9,
    warnings: [],
    usable: true,
    modelUsed: "moonshot/kimi-k3",
  };
  return { imagePath, analyzedAt: "2026-08-06T00:00:00.000Z", analysis };
}

async function tmpIndexFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-figure-index-"));
  const file = path.join(dir, ".sati", "figures-index.json");
  await mkdir(path.dirname(file), { recursive: true });
  return file;
}

async function cleanup(file: string): Promise<void> {
  await rm(path.dirname(path.dirname(file)), { recursive: true, force: true });
}

test("index-store: save → load 往返一致", async () => {
  const file = await tmpIndexFile();
  try {
    const entries = [makeEntry("figures/图1.png", 1), makeEntry("figures/图2.png", 2)];
    await saveFigureIndex(file, entries);

    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 2);
    assert.equal(loaded.warning, undefined);
    assert.equal(loaded.entries[0]?.analysis.figureNumber, 1);
    assert.equal(loaded.entries[1]?.analysis.imagePath, "figures/图2.png");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 缺失文件 → 空索引", async () => {
  const file = await tmpIndexFile();
  try {
    const loaded = await loadFigureIndex(file);
    assert.deepEqual(loaded.entries, []);
    assert.equal(loaded.warning, undefined);
  } finally {
    await cleanup(file);
  }
});

test("index-store: upsert 同图覆盖、新图追加并按附图编号排序", async () => {
  const file = await tmpIndexFile();
  try {
    await upsertFigureIndex(file, makeEntry("figures/图2.png", 2, "底座"));
    await upsertFigureIndex(file, makeEntry("figures/图1.png", 1, "壳体"));
    // 同图重新分析（改名）→ 覆盖而非追加
    await upsertFigureIndex(file, makeEntry("figures/图1.png", 1, "外壳"));

    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 2);
    assert.equal(loaded.entries[0]?.imagePath, "figures/图1.png");
    assert.equal(loaded.entries[0]?.analysis.components[0]?.name, "外壳");
    assert.equal(loaded.entries[1]?.imagePath, "figures/图2.png");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 损坏文件 → 空索引 + warning", async () => {
  const file = await tmpIndexFile();
  try {
    await writeFile(file, "{ 这不是 JSON", "utf8");
    const loaded = await loadFigureIndex(file);
    assert.deepEqual(loaded.entries, []);
    assert.ok(loaded.warning?.includes("损坏"), "应提示损坏");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 版本不兼容 → 空索引 + warning", async () => {
  const file = await tmpIndexFile();
  try {
    await writeFile(file, JSON.stringify({ version: 999, updatedAt: "x", entries: [] }), "utf8");
    const loaded = await loadFigureIndex(file);
    assert.deepEqual(loaded.entries, []);
    assert.ok(loaded.warning?.includes("版本"), "应提示版本不兼容");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 并发 upsert 不丢条目（同文件路径串行化）", async () => {
  const file = await tmpIndexFile();
  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        upsertFigureIndex(file, makeEntry(`figures/图${index + 1}.png`, index + 1)),
      ),
    );
    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 6);
  } finally {
    await cleanup(file);
  }
});

test("index-store: 索引文件写入 version 字段", async () => {
  const file = await tmpIndexFile();
  try {
    await saveFigureIndex(file, [makeEntry("figures/图1.png", 1)]);
    const raw = await import("node:fs/promises").then(m => m.readFile(file, "utf8"));
    const parsed = JSON.parse(raw) as { version: number };
    assert.equal(parsed.version, FIGURE_INDEX_VERSION);
  } finally {
    await cleanup(file);
  }
});

test("index-store: 缺数组字段的条目被过滤并提示（不进入检索崩溃路径）", async () => {
  const file = await tmpIndexFile();
  try {
    const entry = makeEntry("figures/图1.png", 1);
    // 模拟磁盘半写/手改产生的畸形条目（缺 components 数组字段）
    const malformed = {
      ...entry,
      analysis: { ...entry.analysis, components: undefined },
    } as unknown as FigureIndexEntry;
    await saveFigureIndex(file, [entry, malformed]);
    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0]?.imagePath, "figures/图1.png");
    assert.ok(loaded.warning?.includes("1 条无效条目"), "应提示无效条目被忽略");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 并发 upsert 同一 imagePath → 仅保留 1 条（串行化防重复）", async () => {
  const file = await tmpIndexFile();
  try {
    await Promise.all([
      upsertFigureIndex(file, makeEntry("figures/图1.png", 1, "壳体")),
      upsertFigureIndex(file, makeEntry("figures/图1.png", 1, "缓冲层")),
      upsertFigureIndex(file, makeEntry("figures/图1.png", 1, "外壳")),
    ]);
    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0]?.imagePath, "figures/图1.png");
  } finally {
    await cleanup(file);
  }
});

test("index-store: 命中损坏索引时 upsert 保留原始文件备份", async () => {
  const file = await tmpIndexFile();
  try {
    await writeFile(file, "{ 这不是 JSON", "utf8");
    await upsertFigureIndex(file, makeEntry("figures/图1.png", 1));
    const loaded = await loadFigureIndex(file);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0]?.analysis.figureNumber, 1);

    const dir = path.dirname(file);
    const files = await import("node:fs/promises").then(m => m.readdir(dir));
    assert.ok(
      files.some(name => name.startsWith("figures-index.json.corrupt-")),
      "应保留损坏原文件备份",
    );
  } finally {
    await cleanup(file);
  }
});
