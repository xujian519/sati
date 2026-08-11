import assert from "node:assert/strict";
import test from "node:test";
import { checkAtomic } from "../../src/patent/problem/index.js";

// =============================================================================
// 不绑方案（noSolutionBinding）—— 8 陷阱中最高频（问题含方案，审查指南 3.2.1.1）
// =============================================================================

test("不绑方案: 合规问题（无任何手段表述）→ 通过", () => {
  const result = checkAtomic("如何提供可靠的轴向定位");
  assert.equal(result.checks.noSolutionBinding, true);
  assert.equal(result.pass, true);
});

test("不绑方案: 通过设置X → 违规", () => {
  const result = checkAtomic("通过设置限位凸台防止位移");
  assert.equal(result.checks.noSolutionBinding, false);
  assert.equal(result.pass, false);
  assert.ok(result.diagnostics.some(d => d.includes("解决手段")));
});

test("不绑方案: 泛指手段（通过技术手段）→ 不误报", () => {
  const result = checkAtomic("通过现有技术手段降低成本");
  assert.equal(result.checks.noSolutionBinding, true);
  assert.equal(result.pass, true);
});

test("不绑方案: 利用具体装置（利用液冷泵）→ 违规", () => {
  const result = checkAtomic("利用液冷泵降低噪音");
  assert.equal(result.checks.noSolutionBinding, false);
});

test("不绑方案: 结构名词后缀（增设密封圈）→ 违规", () => {
  const result = checkAtomic("增设密封圈以防泄漏");
  assert.equal(result.checks.noSolutionBinding, false);
});

// =============================================================================
// 单一因果（singleCausality）—— 陷阱 3 捆绑问题 / 陷阱 5 复合因果
// =============================================================================

test("单一因果: 单条因果链 → 通过", () => {
  const result = checkAtomic("现有散热方案导致芯片温度超标");
  assert.equal(result.checks.singleCausality, true);
});

test("单一因果: 多个因果连接词 → 违规", () => {
  const result = checkAtomic("温度过高导致芯片损坏，使得整机宕机，进而引发停机");
  assert.equal(result.checks.singleCausality, false);
  assert.equal(result.pass, false);
  assert.ok(result.diagnostics.some(d => d.includes("因果")));
});

test("单一因果: 正常结果宾语（产生热量）不误报为因果链", () => {
  const result = checkAtomic("现有方案产生大量热量，导致散热困难");
  assert.equal(result.checks.singleCausality, true);
});

test("单一因果: 同一连接词重复出现 → 违规", () => {
  const result = checkAtomic("现有方案导致芯片温度超标，导致散热效率下降");
  assert.equal(result.checks.singleCausality, false);
});

// =============================================================================
// 单一可测效果（measurableEffect）—— 质量提示项，不参与 pass 判定
// =============================================================================

test("可测效果: 量化指标（15°C）→ 通过", () => {
  const result = checkAtomic("现有技术温度高 15°C，超出额定上限");
  assert.equal(result.checks.measurableEffect, true);
});

test("可测效果: 无量化指标 → 该项失败但 pass 不受影响", () => {
  const result = checkAtomic("可靠性差");
  assert.equal(result.checks.measurableEffect, false);
  assert.equal(result.pass, true);
  assert.ok(result.diagnostics.some(d => d.includes("可测指标")));
});

test("可测效果: 对比句式（从95°C降至78°C）→ 通过", () => {
  const result = checkAtomic("现有散热方案芯片温度从95°C降至78°C");
  assert.equal(result.checks.measurableEffect, true);
});

// =============================================================================
// 手段可反推（meansReversible）—— 三态，unknown 不阻断
// =============================================================================

test("手段可反推: 现状锚点（现有技术）→ true", () => {
  const result = checkAtomic("现有技术散热方案噪音达 58dB");
  assert.equal(result.checks.meansReversible, true);
});

test("手段可反推: 无锚点 → false（信息性检验，不阻断）", () => {
  const result = checkAtomic("提升用户体验");
  assert.equal(result.checks.meansReversible, false);
  assert.equal(result.pass, true);
});

// =============================================================================
// 组合场景
// =============================================================================

test("组合: 含具体手段即使有量化效果 → 仍违规（绑方案优先）", () => {
  const result = checkAtomic("通过增设液冷泵降低噪音至 42dB");
  assert.equal(result.checks.noSolutionBinding, false);
  assert.equal(result.checks.measurableEffect, true); // 有效果也不能掩盖绑方案
  assert.equal(result.pass, false);
});
