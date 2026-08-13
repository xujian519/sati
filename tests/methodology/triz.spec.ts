import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { triz, lookupMatrixCell } from "../../src/methodology/runtime/components/triz.js";
import { MethodologyRegistry, extractMethodologyKeywords } from "../../src/methodology/runtime/MethodologyRegistry.js";

function ctx(goal: string) {
  return { goal, keywords: extractMethodologyKeywords(goal) };
}

test("identify：矛盾/权衡/规避等触发词命中", () => {
  assert.ok(triz.identify(ctx("这个结构的强度和重量存在矛盾，需要权衡")) > 0);
  assert.ok(triz.identify(ctx("对竞争对手专利做规避设计")) > 0);
  assert.ok(triz.identify(ctx("优化传动效率时体积增大，需要权衡")) > 0);
});

test("identify：无关任务不命中", () => {
  assert.equal(triz.identify(ctx("写一份会议纪要")), 0);
});

test("identify：泛化的改进/优化/重构词不单独触发（归属 pdca/first-principles）", () => {
  assert.equal(triz.identify(ctx("改进生产线流程，优化效率")), 0);
  assert.equal(triz.identify(ctx("重构这套系统的架构")), 0);
});

test("execute prompt 含矛盾定义与矩阵查表步骤", () => {
  const { prompt } = triz.execute(ctx("改进切割装置"));
  assert.ok(prompt.includes("技术矛盾"));
  assert.ok(prompt.includes("矛盾矩阵"));
  assert.ok(prompt.includes("40 发明原理"));
  assert.ok(prompt.includes("规避设计"));
});

test("execute：goal 含工程参数时注入确定性查表结果", () => {
  const { prompt } = triz.execute(ctx("提高强度同时减轻重量"));
  assert.ok(prompt.includes("确定性查表结果"));
  assert.ok(prompt.includes("强度(14)"));
  assert.ok(prompt.includes("重量(1)"));
  assert.ok(prompt.includes("原理 ["));
});

test("execute：goal 无工程参数时不注入查表段", () => {
  const { prompt } = triz.execute(ctx("写一份会议纪要"));
  assert.ok(!prompt.includes("确定性查表结果"));
});

test("lookupMatrixCell 确定性查表", () => {
  // 基准值（广泛引用的经典值，见 commit message 数据来源）：
  // 改善 强度(14) × 恶化 运动物体重量(1)：经典推荐 1, 8, 40, 15
  assert.deepEqual(lookupMatrixCell(14, 1), [1, 8, 40, 15]);
  // 改善 速度(9) × 恶化 力(10)：经典推荐 13, 28, 15, 19
  assert.deepEqual(lookupMatrixCell(9, 10), [13, 28, 15, 19]);
});

// 矩阵数据来源：Altshuller 经典矛盾矩阵（39×39，有值 1190 格、无单值格），
// 由 Casey Perno 2007 转录的 triz_matrix.xls（流传最广的经典矩阵电子转录，
// 源自 Altshuller《Creativity as an Exact Science》1979/1984）程序化转换生成。
// 原始 XLS 行=改善参数、列=恶化参数，JSON 已转置为 [worsening-1][improving-1]；
// 原始文件：
// https://github.com/kamil-szczepanik/TRIZ-Agents/blob/master/data/tools_sources/triz_matrix.xls
// （公开经典数据；'+'/'−' 占位格、无独立来源佐证的单值格与对角线均转为空数组）
test("矩阵数据完整：39×39 且值为 1-40 原理编号", () => {
  const data = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../src/methodology/runtime/components/data/triz-matrix.json",
      ),
      "utf8",
    ),
  ) as number[][][];
  assert.equal(data.length, 39);
  let filled = 0;
  for (const row of data) {
    assert.equal(row.length, 39);
    for (const cell of row) {
      if (cell.length > 0) filled += 1;
      for (const n of cell) {
        assert.ok(n >= 1 && n <= 40, `原理编号越界: ${n}`);
      }
    }
  }
  // 数据版本固化：有值格 1190（Casey Perno xls 主流转录版，防回归）
  assert.equal(filled, 1190);
});

test("矩阵对角线（改善=恶化）为物理矛盾，无经典推荐", () => {
  const data = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../src/methodology/runtime/components/data/triz-matrix.json",
      ),
      "utf8",
    ),
  ) as number[][][];
  for (let i = 0; i < 39; i += 1) {
    assert.deepEqual(data[i]![i], [], `对角线格 [${i + 1}][${i + 1}] 应为空（物理矛盾走分离原理）`);
  }
});

test("40 原理数据完整（40 条，名称非空）", () => {
  const data = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../src/methodology/runtime/components/data/triz-principles.json",
      ),
      "utf8",
    ),
  ) as Array<{ no: number; name: string; description: string }>;
  assert.equal(data.length, 40);
  assert.equal(new Set(data.map(p => p.no)).size, 40);
  assert.deepEqual(
    data.map(p => p.no),
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  for (const p of data) {
    assert.ok(p.name.length > 0);
    assert.ok(p.description.length > 0);
  }
});

test("triz 已注册进默认组件集", () => {
  const reg = new MethodologyRegistry();
  assert.ok(reg.has("triz"));
});
