import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cosineSimilarity, topK } from "../../../src/context/vector/cosine.js";

describe("cosineSimilarity", () => {
  it("相同向量余弦为 1", () => {
    const a = new Float32Array([1, 2, 3]);
    assert.equal(cosineSimilarity(a, new Float32Array([1, 2, 3])), 1);
  });

  it("正交向量余弦为 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it("反方向向量余弦为 -1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1) < 1e-6);
  });

  it("零向量返回 0", () => {
    assert.equal(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
    assert.equal(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([0, 0])), 0);
  });

  it("长度不匹配返回 0", () => {
    assert.equal(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0);
  });

  it("手工可验证的余弦值", () => {
    const a = new Float32Array([3, 4]); // norm 5
    const b = new Float32Array([0, 5]); // norm 5, dot 20
    assert.ok(Math.abs(cosineSimilarity(a, b) - 0.8) < 1e-6);
  });
});

describe("topK", () => {
  it("返回分数最高的 k 个下标（降序）", () => {
    const scores = new Float32Array([0.1, 0.9, 0.5, 0.8]);
    const result = topK(scores, 2);
    // 顺序：最高分下标 1，次高分下标 3
    assert.deepEqual(
      result.map(hit => hit.index),
      [1, 3],
    );
    // Float32 精度：0.9 实际存储为 0.8999999761581421，使用近似比较
    assert.ok(Math.abs(result[0]!.score - 0.9) < 1e-6);
    assert.ok(Math.abs(result[1]!.score - 0.8) < 1e-6);
  });

  it("k 大于长度时返回全部", () => {
    const scores = new Float32Array([0.2, 0.1]);
    assert.equal(topK(scores, 10).length, 2);
  });

  it("k 为 0 返回空", () => {
    assert.deepEqual(topK(new Float32Array([0.5]), 0), []);
  });
});
