import assert from "node:assert/strict";
import test from "node:test";
import { detectDependencyCycle } from "../../../../src/agent/team/taskpool/cycle.js";

const task = (id: string, dependencies: string[]) => ({ id, dependencies });

test("detectDependencyCycle：正常链式依赖不成环", () => {
  const existing = [task("t1", []), task("t2", ["t1"]), task("t3", ["t2"])];
  assert.equal(detectDependencyCycle(existing, "t4", ["t3"]), undefined);
  assert.equal(detectDependencyCycle(existing, "t4", ["t1", "t2"]), undefined);
  assert.equal(detectDependencyCycle(existing, "t4", []), undefined);
});

test("detectDependencyCycle：依赖更新引入环（未来 update dependencies 场景）被检出", () => {
  // 模拟 update：既有任务 t2 已依赖新增任务 t4（t4 依赖 t2 → 环 t4 → t2 → t4）
  const existing = [task("t1", []), task("t2", ["t4"])];
  const cycle = detectDependencyCycle(existing, "t4", ["t2"]);
  assert.ok(cycle !== undefined);
  // 环路径首尾均为 t4（从直接依赖沿依赖链回到新增任务）
  assert.equal(cycle[0], "t4");
  assert.equal(cycle.at(-1), "t4");
  assert.ok(cycle.includes("t2"));
});

test("detectDependencyCycle：既有环（历史脏数据）不误报——仅报告含新增任务的环", () => {
  const existing = [task("t1", ["t2"]), task("t2", ["t1"])]; // 既有环 t1 ↔ t2
  assert.equal(detectDependencyCycle(existing, "t3", ["t1"]), undefined);
});

test("detectDependencyCycle：依赖指向不存在的任务（脏数据）不抛错", () => {
  const existing = [task("t1", [])];
  assert.equal(detectDependencyCycle(existing, "t2", ["ghost"]), undefined);
});
