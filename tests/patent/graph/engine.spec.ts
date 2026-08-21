import assert from "node:assert/strict";
import test from "node:test";
import {
  GRAPH_END,
  GraphBuilder,
  GraphEngineError,
  GraphInterruptError,
  isDegraded,
  type GraphNode,
  type GraphState,
} from "../../../src/patent/graph/index.js";

const node =
  (key: string, value: unknown): GraphNode =>
  async () => ({ [key]: value });

test("GraphBuilder: 编译校验（保留哨兵/未注册节点/非法 maxSteps）", () => {
  const b = new GraphBuilder();
  assert.throws(() => b.addNode(GRAPH_END, node("x", 1)), GraphEngineError);
  assert.throws(() => b.addNode("", node("x", 1)), GraphEngineError);
  b.addNode("a", node("x", 1));
  assert.throws(() => b.addEdge("missing", "a"), GraphEngineError);
  assert.throws(() => b.setNodePolicy("missing", {}), GraphEngineError);
  assert.throws(() => b.compile("missing"), GraphEngineError);
  assert.throws(() => b.compile("a", 0), GraphEngineError);
  assert.throws(() => b.compile("a", 1.5), GraphEngineError);
});

test("engine: 顺序边串行执行", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("n1", node("a", 1))
    .addNode("n2", node("b", 2))
    .addNode("n3", node("c", 3))
    .addEdge("n1", "n2")
    .addEdge("n2", "n3")
    .addEdge("n3", GRAPH_END);
  const graph = builder.compile("n1");
  const result = await graph.run({});
  assert.equal(result.completed, true);
  assert.equal(result.steps, 3);
  assert.deepEqual(result.state, { a: 1, b: 2, c: 3 });
});

test("engine: 并行超步（fan-out 汇聚）+ LWW 确定性", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("entry", node("start", true))
    .addNode("p1", node("k", "p1"))
    .addNode("p2", node("k", "p2"))
    .addNode("merge", node("done", true))
    .addEdge("entry", "p1")
    .addEdge("entry", "p2")
    .addEdge("p1", "merge")
    .addEdge("p2", "merge")
    .addEdge("merge", GRAPH_END);
  const graph = builder.compile("entry");
  const result = await graph.run({});
  assert.equal(result.completed, true);
  // 同超步 p1/p2 写同一 key：LWW 按节点名排序，p2 胜出（p1 < p2）。
  assert.equal(result.state.k, "p2");
  assert.equal(result.state.done, true);
});

test("engine: 条件边扇出（router 返回多目标）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("entry", node("start", true))
    .addNode("left", node("side", "left"))
    .addNode("right", node("side", "right"))
    .addNode("finish", node("end", true))
    .setConditionalEdge("entry", async () => ["left", "right"])
    .addEdge("left", "finish")
    .addEdge("right", "finish")
    .addEdge("finish", GRAPH_END);
  const graph = builder.compile("entry");
  const result = await graph.run({});
  assert.equal(result.completed, true);
  // left/right 同超步写 side：LWW 排序 right 胜出。
  assert.equal(result.state.side, "right");
  assert.equal(result.state.end, true);
});

test("engine: 条件边受控循环 + maxSteps 护栏", async () => {
  let counter = 0;
  const counting: GraphNode = async () => {
    counter += 1;
    return { count: counter };
  };
  const builder = new GraphBuilder();
  builder
    .addNode("loop", counting)
    .setConditionalEdge("loop", async state => ((state.count as number) < 3 ? ["loop"] : [GRAPH_END]));
  const graph = builder.compile("loop", 10);
  const result = await graph.run({});
  assert.equal(result.completed, true);
  assert.equal(counter, 3);
  assert.equal(result.state.count, 3);
});

test("engine: maxSteps 耗尽（死循环护栏）completed=false", async () => {
  const builder = new GraphBuilder();
  builder.addNode("loop", node("n", 1)).setConditionalEdge("loop", async () => ["loop"]);
  const graph = builder.compile("loop", 5);
  const result = await graph.run({});
  assert.equal(result.completed, false);
  assert.equal(result.steps, 5);
});

test("engine: 节点失败 → 降级标记，其余继续（fail-open 默认）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("failing", async () => {
      throw new Error("llm down");
    })
    .addNode("ok", node("done", true))
    .addEdge("failing", "ok")
    .addEdge("ok", GRAPH_END);
  const graph = builder.compile("failing");
  const result = await graph.run({});
  assert.equal(result.completed, true);
  assert.equal(result.state.done, true);
  assert.equal(isDegraded(result.state, "failing"), true);
  assert.equal(result.degraded.length, 1);
  assert.equal(result.degraded[0]?.reason, "node_failed");
});

test("engine: failFast=true 节点失败立即终止", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("failing", async () => {
      throw new Error("boom");
    })
    .addNode("ok", node("done", true))
    .addEdge("failing", "ok");
  const graph = builder.compile("failing");
  const result = await graph.run({}, { failFast: true });
  assert.equal(result.completed, false);
  assert.equal(result.state.done, undefined);
});

test("engine: GraphInterruptError 暂停（completed=false，带 interrupted 信息）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("analyze", node("analysis", "完成"))
    .addNode("approval", async () => {
      throw new GraphInterruptError("需要人工确认", { review_context: "三步法结论" });
    })
    .addNode("after", node("never", true))
    .addEdge("analyze", "approval")
    .addEdge("approval", "after");
  const graph = builder.compile("analyze");
  const result = await graph.run({});
  assert.equal(result.completed, false);
  assert.deepEqual(result.interrupted, {
    node: "approval",
    message: "需要人工确认",
    data: { review_context: "三步法结论" },
  });
  assert.equal(result.state.analysis, "完成");
  assert.equal(result.state.never, undefined);
});

test("engine: onSuperStepStart 钩子（检查点预留）", async () => {
  const seen: Array<{ step: number; active: string[] }> = [];
  const builder = new GraphBuilder();
  builder.addNode("a", node("x", 1)).addNode("b", node("y", 2)).addEdge("a", "b").addEdge("b", GRAPH_END);
  const graph = builder.compile("a");
  await graph.run(
    {},
    {
      onSuperStepStart: (step, active) => {
        seen.push({ step, active: [...active] });
      },
    },
  );
  assert.deepEqual(seen, [
    { step: 0, active: ["a"] },
    { step: 1, active: ["b"] },
  ]);
});

test("engine: sideEffect 节点 delta 不合并", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("notify", node("flag", true))
    .addNode("main", node("result", "ok"))
    .setNodePolicy("notify", { sideEffect: true })
    .addEdge("notify", "main")
    .addEdge("main", GRAPH_END);
  const graph = builder.compile("notify");
  const result = await graph.run({});
  assert.equal(result.state.flag, undefined);
  assert.equal(result.state.result, "ok");
});

test("engine: 节点访问深拷贝快照（并行不互相污染）", async () => {
  const builder = new GraphBuilder();
  const reader: GraphNode = async ({ state }) => ({ saw: (state as GraphState).injected });
  builder
    .addNode("inject", node("injected", "seed"))
    .addNode("read1", reader)
    .addNode("read2", reader)
    .addEdge("inject", "read1")
    .addEdge("inject", "read2")
    .addEdge("read1", GRAPH_END)
    .addEdge("read2", GRAPH_END);
  const graph = builder.compile("inject");
  const result = await graph.run({});
  assert.equal(result.state.saw, "seed");
});

test("engine: resume 需要 GraphCheckpoint（未接线时行为由 checkpoint 层定义）", async () => {
  const builder = new GraphBuilder();
  builder.addNode("a", node("x", 1)).addEdge("a", GRAPH_END);
  const graph = builder.compile("a");
  // resume 接受 GraphCheckpoint；传最小合法对象可恢复执行。
  const result = await graph.resume({
    id: "cp-1",
    graphId: "g",
    stepIndex: 0,
    state: {},
    activeNodes: ["a"],
    createdAt: 1,
  });
  assert.equal(result.completed, true);
  assert.equal(result.state.x, 1);
});

test("engine: nodeDurations 记录全部执行节点（字典序确定性）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("zebra", node("z", 1))
    .addNode("alpha", node("a", 2))
    .addNode("mid", node("m", 3))
    .addEdge("zebra", "alpha")
    .addEdge("alpha", "mid")
    .addEdge("mid", GRAPH_END);
  const graph = builder.compile("zebra");
  const result = await graph.run({});
  assert.equal(result.completed, true);
  assert.deepEqual(
    result.nodeDurations?.map(d => d.node),
    ["alpha", "mid", "zebra"],
  );
  for (const d of result.nodeDurations ?? []) {
    assert.equal(typeof d.durationMs, "number");
    assert.ok(d.durationMs >= 0);
  }
});

test("engine: nodeDurations 覆盖并行超步与中断节点", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("entry", node("start", true))
    .addNode("p1", node("k", 1))
    .addNode("p2", node("k", 2))
    .addNode("gate", async () => {
      throw new GraphInterruptError("暂停", { review_context: "x" });
    })
    .addEdge("entry", "p1")
    .addEdge("entry", "p2")
    .addEdge("p1", "gate")
    .addEdge("p2", "gate");
  const graph = builder.compile("entry");
  const result = await graph.run({});
  assert.equal(result.completed, false);
  assert.equal(result.interrupted?.node, "gate");
  // 中断前 entry/p1/p2 已执行并计时，gate 节点本身也已计时。
  assert.deepEqual(
    result.nodeDurations?.map(d => d.node),
    ["entry", "gate", "p1", "p2"],
  );
});
