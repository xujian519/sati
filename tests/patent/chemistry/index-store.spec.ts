/**
 * src/patent/chemistry — 化学索引持久化测试（对齐 figure/index-store）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CHEMISTRY_INDEX_VERSION,
  loadChemistryIndex,
  saveChemistryIndex,
  upsertChemistryIndex,
  type ChemistryIndexEntry,
} from "../../../src/patent/chemistry/index.js";
import type { ChemicalStructureResult } from "../../../src/patent/chemistry/types.js";

function makeResult(overrides: Partial<ChemicalStructureResult> = {}): ChemicalStructureResult {
  return {
    kind: "structure",
    candidates: [],
    chosenIndex: -1,
    names: [],
    confidence: 0,
    warnings: [],
    needHumanReview: true,
    usable: false,
    modelUsed: "moonshot/kimi-k3",
    ...overrides,
  };
}

function makeEntry(sourceKey: string, overrides: Partial<ChemicalStructureResult> = {}): ChemistryIndexEntry {
  return {
    sourceKey,
    analyzedAt: "2026-08-07T00:00:00.000Z",
    analysis: makeResult(overrides),
  };
}

test("index-store: 缺失文件 → 空索引", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-index-"));
  try {
    const { entries, warning } = await loadChemistryIndex(path.join(dir, "missing.json"));
    assert.equal(entries.length, 0);
    assert.equal(warning, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("index-store: upsert 新增 + 同源覆盖 + 排序", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-index-"));
  try {
    const file = path.join(dir, ".sati", "chemistry-index.json");
    await upsertChemistryIndex(file, makeEntry("fig1.png", { kind: "structure" }));
    await upsertChemistryIndex(file, makeEntry("fig2.png", { kind: "markush" }));
    // 同源覆盖：fig1.png 改为 formula
    await upsertChemistryIndex(file, makeEntry("fig1.png", { kind: "formula" }));

    const { entries } = await loadChemistryIndex(file);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map(e => e.sourceKey),
      ["fig1.png", "fig2.png"],
    );
    assert.equal(entries[0]?.analysis.kind, "formula", "同源条目应被覆盖");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("index-store: 损坏文件 → 空索引 + warning（不抛出）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-index-"));
  try {
    const file = path.join(dir, "index.json");
    await writeFile(file, "{ not valid json", "utf8");
    const { entries, warning } = await loadChemistryIndex(file);
    assert.equal(entries.length, 0);
    assert.ok(warning?.includes("损坏"), "应返回损坏提示");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("index-store: 版本不兼容 → 空索引 + warning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-index-"));
  try {
    const file = path.join(dir, "index.json");
    await saveChemistryIndex(file, [makeEntry("fig1.png")]);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.replace(`"version": ${CHEMISTRY_INDEX_VERSION}`, '"version": 999'), "utf8");
    const { entries, warning } = await loadChemistryIndex(file);
    assert.equal(entries.length, 0);
    assert.ok(warning?.includes("版本不兼容"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("index-store: 无效条目被忽略并提示", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-index-"));
  try {
    const file = path.join(dir, "index.json");
    await saveChemistryIndex(file, [makeEntry("ok.png")]);
    // 混入一条缺数组字段的非法条目
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { entries: unknown[] };
    parsed.entries.push({ sourceKey: "bad.png", analyzedAt: "x", analysis: { kind: "structure" } });
    await writeFile(file, JSON.stringify(parsed), "utf8");

    const { entries, warning } = await loadChemistryIndex(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.sourceKey, "ok.png");
    assert.ok(warning?.includes("无效条目"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
