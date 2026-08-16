import assert from "node:assert/strict";
import test from "node:test";
import { compileSignal, signalFor, signalMatches } from "../../../src/patent/workflow/signal.js";
import type { WorkflowStage } from "../../../src/patent/workflow/types.js";

test("signalMatches: 命中信号且前窗口无否定词无句界 → true", () => {
  const signal = compileSignal("不一致|矛盾|缺少");
  assert.equal(signalMatches("PFE 一致性检查：发现特征与效果不一致", signal), true);
});

test("signalMatches: 前窗口含否定词（未发现不一致）不触发", () => {
  const signal = compileSignal("不一致|矛盾|缺少");
  assert.equal(signalMatches("未发现不一致，因果链闭合", signal), false);
});

test("signalMatches: 前窗口含句界（特征完整。不一致）不触发", () => {
  const signal = compileSignal("不一致");
  // 匹配位置前 12 字符内有 "。" → 窗口判定跳过 → 不触发（原语义锁定）
  assert.equal(signalMatches("特征完整。不一致的情况不存在", signal), false);
});

test("signalMatches: g-flag lastIndex 跨调用重置（同正则连续判定不串状态）", () => {
  const signal = compileSignal("不一致");
  assert.equal(signalMatches("甲 不一致 乙", signal), true);
  // 若不重置 lastIndex，第二次 exec 会从上次匹配之后继续 → 漏检或误判
  assert.equal(signalMatches("无不一致", signal), false);
  assert.equal(signalMatches("再次不一致", signal), true);
});

test("signalMatches: 空匹配不死循环（空窗口恒触发）", () => {
  const signal = compileSignal("x*");
  // 位置 0 空匹配时 before 恒为空串（无句界无否定词）→ 恒触发 true；
  // 测试完成即验证了 exec 空匹配自增（lastIndex+1）不陷入死循环
  assert.equal(signalMatches("abc", signal), true);
});

test("signalFor: 无 retry 返回 undefined；有 retry 编译并缓存同引用", () => {
  const cache = new Map<string, RegExp>();
  const plain: WorkflowStage = { id: "s1", strategy: "chain", description: "d" };
  assert.equal(signalFor(plain, cache), undefined);

  const withRetry: WorkflowStage = {
    id: "s2",
    strategy: "chain",
    description: "d",
    retry: { whenOutputMatches: "不一致|矛盾" },
  };
  const first = signalFor(withRetry, cache);
  assert.ok(first instanceof RegExp);
  const second = signalFor(withRetry, cache);
  assert.equal(first, second, "缓存命中应返回同一正则实例");
  assert.equal(first.flags, "gi", "信号正则必须带 g 标志（exec 遍历全部匹配位置）");
});
