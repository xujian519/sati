import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NEGATION_WINDOW,
  DEFAULT_NEGATION_WORDS,
  hasNegationContext,
  parseCnNumber,
} from "../../src/rule/runtime/text-utils.js";

// ---------------------------------------------------------------------------
// hasNegationContext
// ---------------------------------------------------------------------------

test("hasNegationContext：否定词命中（默认窗口与词表）", () => {
  assert.equal(hasNegationContext("本方案避免侵权", 5), true);
  assert.equal(hasNegationContext("该方案防止侵权", 5), true);
  assert.equal(hasNegationContext("本方案不构成侵权", 6), true);
  assert.equal(hasNegationContext("该方法避免了对现有技术的侵权", 12), true);
});

test("hasNegationContext：句界分隔否定不跨句", () => {
  assert.equal(hasNegationContext("本方案避免侵权。但需注意侵权风险", 15), false);
  assert.equal(hasNegationContext("本方案避免侵权！仍需注意侵权风险", 15), false);
  assert.equal(hasNegationContext("本方案避免侵权？仍需注意侵权风险", 15), false);
  assert.equal(hasNegationContext("本方案避免侵权\n但需注意侵权风险", 15), false);
});

test("hasNegationContext：窗口外否定不算", () => {
  const far = "避免".padEnd(DEFAULT_NEGATION_WINDOW + 10, "字") + "侵权";
  assert.equal(hasNegationContext(far, far.length - 2), false);
});

test("hasNegationContext：复合词吞入的否定词不算（无可避免的侵权仍是侵权陈述）", () => {
  assert.equal(hasNegationContext("使用无可避免的侵权风险", 7), false);
  assert.equal(hasNegationContext("存在不可避免的侵权风险", 7), false);
});

test("hasNegationContext：自定义词表与窗口（synonym-engine 场景）", () => {
  const custom = ["无法证明", "不具有"];
  assert.equal(hasNegationContext("本方案无法证明新颖性", 7, { window: 60, negationWords: custom }), true);
  // 自定义词表不含"避免" → 不算否定
  assert.equal(hasNegationContext("本方案避免侵权", 5, { window: 60, negationWords: custom }), false);
});

test("hasNegationContext：默认导出词表与既有镜像一致", () => {
  assert.deepEqual(
    [...DEFAULT_NEGATION_WORDS],
    ["防止", "避免", "不用于", "排除", "禁止", "不为", "非用于", "不构成", "区别于", "不属于"],
  );
});

// ---------------------------------------------------------------------------
// parseCnNumber
// ---------------------------------------------------------------------------

test("parseCnNumber：阿拉伯数字直接解析", () => {
  assert.equal(parseCnNumber("82"), 82);
  assert.equal(parseCnNumber("0"), 0);
});

test("parseCnNumber：X十Y 组合", () => {
  assert.equal(parseCnNumber("二十二"), 22);
  assert.equal(parseCnNumber("十"), 10);
  assert.equal(parseCnNumber("一十"), 10);
  assert.equal(parseCnNumber("四十五"), 45);
  assert.equal(parseCnNumber("七十八"), 78);
});

test("parseCnNumber：百位组合（含零占位）", () => {
  assert.equal(parseCnNumber("一百零二"), 102);
  assert.equal(parseCnNumber("二百零五"), 205);
  assert.equal(parseCnNumber("一百二十"), 120);
  assert.equal(parseCnNumber("一百二十六"), 126);
  assert.equal(parseCnNumber("三百四十五"), 345);
  assert.equal(parseCnNumber("一百"), 100);
});

test("parseCnNumber：千位组合", () => {
  assert.equal(parseCnNumber("一千二百三十四"), 1234);
  assert.equal(parseCnNumber("一千零一"), 1001);
});

test("parseCnNumber：非法输入返回 null", () => {
  assert.equal(parseCnNumber("abc"), null);
  assert.equal(parseCnNumber("十二abc"), null);
  assert.equal(parseCnNumber(""), null);
});
