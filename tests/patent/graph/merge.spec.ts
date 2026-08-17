import assert from "node:assert/strict";
import test from "node:test";
import { GraphMergeError, mergeWithSchema, type GraphState, type Reducer } from "../../../src/patent/graph/index.js";

const results = (entries: Array<[string, GraphState]>): Array<{ node: string; delta: GraphState }> =>
  entries.map(([node, delta]) => ({ node, delta }));

test("mergeWithSchema LWW: 节点名字典序后者覆盖（确定性）", () => {
  const state: GraphState = {};
  // "a_node" < "b_node"：字典序后者 b_node 胜出。
  mergeWithSchema(
    state,
    results([
      ["b_node", { key: "b" }],
      ["a_node", { key: "a" }],
    ]),
    {},
  );
  assert.equal(state.key, "b");
});

test("mergeWithSchema LWW: 未注册 key 回落 last_write_wins", () => {
  const state: GraphState = { k: 1 };
  mergeWithSchema(state, results([["n1", { k: 2 }]]), { other: "append" });
  assert.equal(state.k, 2);
});

test("mergeWithSchema append: 追加到已有数组", () => {
  const state: GraphState = { list: ["a"] };
  mergeWithSchema(state, results([["n1", { list: "b" }]]), { list: "append" });
  assert.deepEqual(state.list, ["a", "b"]);
});

test("mergeWithSchema append: 非数组既有值视为空数组", () => {
  const state: GraphState = { list: "x" };
  mergeWithSchema(state, results([["n1", { list: "b" }]]), { list: "append" });
  assert.deepEqual(state.list, ["b"]);
});

test("mergeWithSchema union: 数组合并去重保持顺序", () => {
  const state: GraphState = { list: ["a", "b"] };
  mergeWithSchema(
    state,
    results([
      ["n1", { list: ["b", "c"] }],
      ["n2", { list: "a" }],
    ]),
    { list: "union" },
  );
  assert.deepEqual(state.list, ["a", "b", "c"]);
});

test("mergeWithSchema merge_map: map 浅合并", () => {
  const state: GraphState = { m: { x: 1 } };
  mergeWithSchema(state, results([["n1", { m: { y: 2 } }]]), { m: "merge_map" });
  assert.deepEqual(state.m, { x: 1, y: 2 });
});

test("mergeWithSchema fail_on_conflict: 同 key 重复写入抛错", () => {
  const state: GraphState = { k: 1 };
  assert.throws(() => mergeWithSchema(state, results([["n1", { k: 2 }]]), { k: "fail_on_conflict" }), GraphMergeError);
});

test("mergeWithSchema fail_on_conflict: 首次写入不冲突", () => {
  const state: GraphState = {};
  mergeWithSchema(state, results([["n1", { k: 2 }]]), { k: "fail_on_conflict" });
  assert.equal(state.k, 2);
});

test("mergeWithSchema: 未知 reducer 抛错", () => {
  const state: GraphState = {};
  assert.throws(
    () => mergeWithSchema(state, results([["n1", { k: 1 }]]), { k: "bogus" as unknown as Reducer }),
    /未知 Reducer/,
  );
});
