import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GraphBuilder,
  GraphInterruptError,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  runGraphWithCheckpoints,
  type GraphCheckpoint,
  type GraphState,
} from "../../../src/patent/index.js";

const node = (key: string, value: unknown) => async (): Promise<GraphState> => ({ [key]: value });

test("InMemoryCheckpointStore: save/load/loadLatest/list", async () => {
  const store = new InMemoryCheckpointStore();
  const cp1: GraphCheckpoint = {
    id: "g-0",
    graphId: "g",
    stepIndex: 0,
    state: { a: 1 },
    activeNodes: ["b"],
    createdAt: 1,
  };
  const cp2: GraphCheckpoint = {
    id: "g-1",
    graphId: "g",
    stepIndex: 1,
    state: { a: 1, b: 2 },
    activeNodes: ["c"],
    createdAt: 2,
  };
  await store.save(cp1);
  await store.save(cp2);
  assert.deepEqual((await store.load("g-0"))?.state, { a: 1 });
  assert.equal((await store.load("missing")) === undefined, true);
  // loadLatest 取 stepIndex 最大者。
  assert.equal((await store.loadLatest("g"))?.id, "g-1");
  assert.deepEqual(await store.list("g"), ["g-0", "g-1"]);
});

test("JsonFileCheckpointStore: 序列化 round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-cp-"));
  try {
    const store = new JsonFileCheckpointStore(dir);
    const cp: GraphCheckpoint = {
      id: "g-3",
      graphId: "g",
      stepIndex: 3,
      state: { features: ["F1"], nested: { deep: true } },
      activeNodes: ["next"],
      createdAt: 42,
    };
    await store.save(cp);
    const loaded = await store.load("g-3");
    assert.deepEqual(loaded, cp);
    assert.equal((await store.loadLatest("g"))?.id, "g-3");
    assert.deepEqual(await store.list("g"), ["g-3"]);
    assert.deepEqual(await store.list("other"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runGraphWithCheckpoints: 中断后 resume 从正确超步继续", async () => {
  let shouldInterrupt = true;
  const builder = new GraphBuilder();
  builder
    .addNode("a", node("a", 1))
    .addNode("gate", async () => {
      if (shouldInterrupt) {
        shouldInterrupt = false;
        throw new GraphInterruptError("审批暂停", { review_context: "确认" });
      }
      return { gate_passed: true };
    })
    .addNode("c", node("c", 3))
    .addEdge("a", "gate")
    .addEdge("gate", "c");
  const graph = builder.compile("a");
  const store = new InMemoryCheckpointStore();

  // 第一次：gate 中断。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g1" });
  assert.equal(first.result.completed, false);
  assert.equal(first.result.interrupted?.node, "gate");
  assert.ok(first.checkpointId);

  // resume：从最新检查点继续，gate 放行，c 执行。
  const latest = await store.loadLatest("g1");
  assert.ok(latest);
  const second = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g1", resumeFrom: latest });
  assert.equal(second.result.completed, true);
  assert.equal(second.result.state.a, 1);
  assert.equal(second.result.state.gate_passed, true);
  assert.equal(second.result.state.c, 3);
});

test("runGraphWithCheckpoints: 完成路径亦保存最终态检查点", async () => {
  const builder = new GraphBuilder();
  builder.addNode("a", node("done", true)).addEdge("a", "__end__");
  const graph = builder.compile("a");
  const store = new InMemoryCheckpointStore();
  const { result, checkpointId } = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g2" });
  assert.equal(result.completed, true);
  assert.ok(checkpointId);
  const cp = await store.load(checkpointId!);
  assert.equal(cp?.activeNodes[0], "a");
});
