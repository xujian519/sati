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
  assert.ok(triz.identify(ctx("优化传动效率同时减小体积")) > 0);
});

test("identify：无关任务不命中", () => {
  assert.equal(triz.identify(ctx("写一份会议纪要")), 0);
});

test("execute prompt 含矛盾定义与矩阵查表步骤", () => {
  const { prompt } = triz.execute(ctx("改进切割装置"));
  assert.ok(prompt.includes("技术矛盾"));
  assert.ok(prompt.includes("矛盾矩阵"));
  assert.ok(prompt.includes("40 发明原理"));
});

// lookupMatrixCell 依赖 triz-matrix.json（39×39 矛盾矩阵），该数据在 Task 11
// 补齐。数据就位后恢复为 test(...) 启用。
test.skip("lookupMatrixCell 确定性查表", () => {
  // 强度(14) 恶化 运动物体重量(1)：经典推荐 1, 8, 40, 15
  assert.deepEqual(lookupMatrixCell(14, 1), [1, 8, 40, 15]);
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
  for (const p of data) {
    assert.ok(p.name.length > 0);
    assert.ok(p.description.length > 0);
  }
});

test("triz 已注册进默认组件集", () => {
  const reg = new MethodologyRegistry();
  assert.ok(reg.has("triz"));
});
