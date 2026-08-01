import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reciprocalRankFusion } from "../../../src/context/vector/rrf.js";

describe("reciprocalRankFusion", () => {
  it("单路结果按排名原序输出", () => {
    const fused = reciprocalRankFusion([[{ id: "a" }, { id: "b" }, { id: "c" }]]);
    assert.deepEqual(
      fused.map(item => item.id),
      ["a", "b", "c"],
    );
    assert.ok(fused[0]!.score > fused[1]!.score);
    assert.ok(fused[1]!.score > fused[2]!.score);
  });

  it("多路交集分数累加后置顶", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "c" }],
    ]);
    // b 在两路中分别 rank 1（1/61）与 rank 0（1/61），累加后最高
    assert.equal(fused[0]!.id, "b");
  });

  it("语义独有命中也能进入融合结果", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "x" }, { id: "b" }],
    ]);
    const ids = fused.map(item => item.id);
    assert.ok(ids.includes("x"));
  });

  it("自定义 k 影响分值但不影响相对排序（同路内）", () => {
    const k5 = reciprocalRankFusion([[{ id: "a" }, { id: "b" }]], 5);
    const k60 = reciprocalRankFusion([[{ id: "a" }, { id: "b" }]], 60);
    assert.deepEqual(
      k5.map(item => item.id),
      k60.map(item => item.id),
    );
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
  });
});
