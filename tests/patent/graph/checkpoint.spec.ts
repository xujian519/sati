import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_NODES_KEY,
  GraphBuilder,
  GraphInterruptError,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  grantApproval,
  isGateApproved,
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

test("grantApproval：写入门粒度放行记录后 resume 通过审批门（HITL 闭环）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("a", node("a", 1))
    .addNode("gate", async ({ state, nodeName }) => {
      // 引擎必须注入节点名——门粒度判定（放行记录按门 id）依赖它。
      assert.equal(nodeName, "gate", "引擎向节点注入其在图内的名字");
      if (!isGateApproved(state, nodeName)) {
        throw new GraphInterruptError("审批暂停", { review_context: "确认" });
      }
      return { gate_passed: true };
    })
    .addNode("c", node("c", 3))
    .addEdge("a", "gate")
    .addEdge("gate", "c");
  const graph = builder.compile("a");
  const store = new InMemoryCheckpointStore();

  // 第一次：审批门中断，拿到 checkpointId。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g2" });
  assert.equal(first.result.completed, false);
  assert.equal(first.result.interrupted?.node, "gate");
  assert.ok(first.checkpointId);

  // 人工批准：grantApproval 把「该检查点正在等待的门 id」写入 state（非全局布尔）。
  const granted = await grantApproval(store, first.checkpointId!);
  assert.ok(granted);
  assert.deepEqual(granted.state[APPROVAL_GRANTED_NODES_KEY], ["gate"], "放行记录 = 被批准的门节点 id");
  assert.equal(
    granted.state[APPROVAL_GRANTED_KEY],
    undefined,
    "共享 state 不得出现全局放行布尔（会让一次放行泄漏到后续所有门）",
  );

  // 幂等：重复批准无副作用，放行记录不变。
  const grantedAgain = await grantApproval(store, first.checkpointId!);
  assert.ok(grantedAgain);
  assert.deepEqual(grantedAgain.state[APPROVAL_GRANTED_NODES_KEY], ["gate"]);

  // 审批后 resume：审批门放行，后续节点执行（真正通过审批门）。
  const second = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g2", resumeFrom: granted });
  assert.equal(second.result.completed, true);
  assert.equal(second.result.state.gate_passed, true);
  assert.equal(second.result.state.c, 3);
});

test("grantApproval：批准非门检查点不放行任何门（fail-closed，不静默放行下游）", async () => {
  const builder = new GraphBuilder();
  builder
    .addNode("a", node("a", 1))
    .addNode("gate", async ({ state, nodeName }) => {
      if (!isGateApproved(state, nodeName ?? "")) {
        throw new GraphInterruptError("审批暂停", { review_context: "确认" });
      }
      return { gate_passed: true };
    })
    .addNode("c", node("c", 3))
    .addEdge("a", "gate")
    .addEdge("gate", "c");
  const graph = builder.compile("a");
  const store = new InMemoryCheckpointStore();
  await runGraphWithCheckpoints(graph, {}, { store, graphId: "g3" });

  // 批准「入口超步」的检查点（activeNodes = ["a"]，没有任何门）→ 放行记录里没有 gate。
  const wrong = await grantApproval(store, "g3-0");
  assert.ok(wrong);
  assert.deepEqual(wrong.state[APPROVAL_GRANTED_NODES_KEY], ["a"], "批准记录只含该检查点待执行节点");

  const resumed = await runGraphWithCheckpoints(graph, {}, { store, graphId: "g3", resumeFrom: wrong });
  assert.equal(resumed.result.completed, false, "批准非门检查点后仍在门处暂停");
  assert.equal(resumed.result.interrupted?.node, "gate");
  assert.equal(resumed.result.state.gate_passed, undefined, "门未被放行：下游节点未执行");
});

test("grantApproval：检查点不存在返回 undefined", async () => {
  const store = new InMemoryCheckpointStore();
  assert.equal(await grantApproval(store, "missing"), undefined);
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
