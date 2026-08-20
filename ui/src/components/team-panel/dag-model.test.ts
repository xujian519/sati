import { describe, expect, test } from "vitest";
import { computeDagLayout } from "./dag-model";
import type { PanelTask } from "./types";

const task = (taskId: string, dependencies: string[] = [], status = "pending"): PanelTask => ({
  taskId,
  subject: `subject of ${taskId}`,
  status,
  attempt: 1,
  dependencies,
  blockedByCount: dependencies.length,
});

describe("computeDagLayout", () => {
  test("空输入：空布局且视为并行", () => {
    const layout = computeDagLayout([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.isParallel).toBe(true);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  test("链 a→b→c：3 列分层，边方向为依赖方→依赖者", () => {
    const layout = computeDagLayout([task("a"), task("b", ["a"]), task("c", ["b"])]);
    expect(layout.isParallel).toBe(false);
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]));
    expect(byId.get("a")!.depth).toBe(0);
    expect(byId.get("b")!.depth).toBe(1);
    expect(byId.get("c")!.depth).toBe(2);
    expect(byId.get("c")!.x).toBeGreaterThan(byId.get("b")!.x);
  });

  test("菱形 a→b, a→c, b→d, c→d：depth 0/1/1/2", () => {
    const layout = computeDagLayout([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]);
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]));
    expect(byId.get("a")!.depth).toBe(0);
    expect(byId.get("b")!.depth).toBe(1);
    expect(byId.get("c")!.depth).toBe(1);
    expect(byId.get("d")!.depth).toBe(2);
    // 同层行按 taskId 字典序：b < c
    expect(byId.get("b")!.row).toBeLessThan(byId.get("c")!.row);
    expect(layout.edges).toHaveLength(4);
  });

  test("环 a→b→a：不死循环，环上节点 depth 0 兜底", () => {
    const layout = computeDagLayout([task("a", ["b"]), task("b", ["a"])]);
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]));
    expect(byId.get("a")!.depth).toBe(0);
    expect(byId.get("b")!.depth).toBe(0);
  });

  test("环 + 非环节点：深度不受输入顺序影响（环归 0，依赖者 depth 1）", () => {
    // 旧实现单遍 DFS：p 先算时会把调用链（含非环祖先 p）误入环集合，
    // p 深度 0；p 后算时深度 1——同一张图两种布局。
    const make = () => [task("p", ["a"]), task("a", ["b"]), task("b", ["a"])];
    const forward = new Map(computeDagLayout(make()).nodes.map(node => [node.task.taskId, node]));
    expect(forward.get("a")!.depth).toBe(0);
    expect(forward.get("b")!.depth).toBe(0);
    expect(forward.get("p")!.depth).toBe(1);
    const reversed = new Map(computeDagLayout([...make()].reverse()).nodes.map(node => [node.task.taskId, node]));
    expect(reversed.get("a")!.depth).toBe(0);
    expect(reversed.get("b")!.depth).toBe(0);
    expect(reversed.get("p")!.depth).toBe(1);
  });

  test("两个独立环 + 公共依赖者：两环成员各自归 0，依赖者按链长计深", () => {
    const layout = computeDagLayout([
      task("a", ["b"]),
      task("b", ["a"]), // 环 1：a↔b
      task("c", ["d"]),
      task("d", ["c"]), // 环 2：c↔d
      task("top", ["a", "c"]), // 同时依赖两环
    ]);
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]));
    expect(byId.get("a")!.depth).toBe(0);
    expect(byId.get("b")!.depth).toBe(0);
    expect(byId.get("c")!.depth).toBe(0);
    expect(byId.get("d")!.depth).toBe(0);
    expect(byId.get("top")!.depth).toBe(1);
  });

  test("悬空依赖与自依赖被忽略", () => {
    const layout = computeDagLayout([
      task("a", ["ghost", "a"]), // 悬空 + 自依赖
      task("b", ["a"]),
    ]);
    expect(layout.edges).toEqual([{ from: "a", to: "b" }]);
    const byId = new Map(layout.nodes.map(node => [node.task.taskId, node]));
    expect(byId.get("a")!.depth).toBe(0);
    expect(byId.get("b")!.depth).toBe(1);
  });

  test("无依赖任务：isParallel true，并排一行", () => {
    const layout = computeDagLayout([task("x"), task("y"), task("z")]);
    expect(layout.isParallel).toBe(true);
    expect(layout.nodes).toHaveLength(3);
    // 全部 depth 0，行按字典序
    expect(layout.nodes.map(node => node.task.taskId)).toEqual(["x", "y", "z"]);
    expect(layout.nodes.every(node => node.depth === 0)).toBe(true);
    expect(new Set(layout.nodes.map(node => node.row))).toEqual(new Set([0, 1, 2]));
  });

  test("确定性：同输入两次调用输出深等价", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"])];
    const first = computeDagLayout(tasks);
    const second = computeDagLayout(tasks);
    expect(second).toEqual(first);
  });
});
