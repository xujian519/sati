import assert from "node:assert/strict";
import test from "node:test";
import {
  DEGRADATION_SUFFIX,
  degradationSummary,
  getDegradationMark,
  isDegraded,
  markDegraded,
  type GraphState,
  type StateDelta,
} from "../../../src/patent/graph/index.js";

test("markDegraded: 写 fallback 值与并列降级标记", () => {
  const delta: StateDelta = {};
  markDegraded(delta, "prior_art", [], "search_failed", "检索失败", "warning");
  assert.deepEqual(delta.prior_art, []);
  assert.deepEqual(delta[`prior_art${DEGRADATION_SUFFIX}`], {
    reason: "search_failed",
    message: "检索失败",
    severity: "warning",
  });
});

test("isDegraded / getDegradationMark: 读取标记", () => {
  const state: GraphState = {};
  const delta: StateDelta = {};
  markDegraded(delta, "features", [], "llm_unavailable", "LLM 不可用");
  Object.assign(state, delta);
  assert.equal(isDegraded(state, "features"), true);
  assert.equal(isDegraded(state, "other"), false);
  assert.deepEqual(getDegradationMark(state, "features"), {
    reason: "llm_unavailable",
    message: "LLM 不可用",
    severity: "warning",
  });
  assert.equal(getDegradationMark(state, "other"), undefined);
});

test("degradationSummary: 汇总全部标记（按 key 字典序）", () => {
  const state: GraphState = {};
  const a: StateDelta = {};
  const b: StateDelta = {};
  markDegraded(a, "prior_art", [], "search_failed", "检索失败", "critical");
  markDegraded(b, "features", [], "llm_unavailable", "LLM 不可用");
  Object.assign(state, a, b);
  state["normal_key"] = "正常数据";
  const summary = degradationSummary(state);
  assert.equal(summary.length, 2);
  // 字典序：features__degradation < prior_art__degradation
  assert.equal(summary[0]?.reason, "llm_unavailable");
  assert.equal(summary[1]?.reason, "search_failed");
});

test("degradationSummary: 结构异常的标记 key 被忽略", () => {
  const state: GraphState = { [`bad${DEGRADATION_SUFFIX}`]: "not-an-object" };
  assert.deepEqual(degradationSummary(state), []);
});
