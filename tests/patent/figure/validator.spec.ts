/**
 * src/patent/figure — 电学符号校验器测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElectricalAnalysis } from "../../../src/patent/figure/types.js";
import { extractClaimRefs, validateElectricalAnalysis } from "../../../src/patent/figure/validator.js";

function baseAnalysis(overrides: Partial<ElectricalAnalysis> = {}): ElectricalAnalysis {
  return {
    components: [
      { ref: "R1", symbol: "resistor", category: "passive", name: "电阻", value: "10kΩ", terminalCount: 2 },
      { ref: "C2", symbol: "capacitor", category: "passive", name: "电容", terminalCount: 2 },
    ],
    nets: [
      { name: "VCC", connectedRefs: ["R1.1"] },
      { name: "N1", connectedRefs: ["R1.2", "C2.1"] },
      { name: "GND", connectedRefs: ["C2.2"] },
    ],
    ...overrides,
  };
}

test("校验：合法分析无结构性问题", () => {
  const result = validateElectricalAnalysis(baseAnalysis());
  assert.equal(result.hasStructuralIssues, false);
  // GND/VCC 单引脚网络不报悬空；无文字上下文不报图文对齐
  assert.ok(!result.warnings.some(w => w.includes("悬空")));
});

test("校验：标号前缀与符号类别不一致时告警", () => {
  const analysis = baseAnalysis({
    components: [{ ref: "R1", symbol: "capacitor", category: "passive", name: "电容", terminalCount: 2 }],
  });
  const result = validateElectricalAnalysis(analysis);
  assert.ok(
    result.warnings.some(w => w.includes("R1") && w.includes("电阻")),
    "R 前缀应提示对应电阻",
  );
  assert.equal(result.hasStructuralIssues, true);
});

test("校验：未知标号前缀告警", () => {
  const analysis = baseAnalysis({
    components: [
      { ref: "R1", symbol: "resistor", category: "passive", name: "电阻", terminalCount: 2 },
      { ref: "X9", symbol: "unknown", category: "unknown", name: "神秘元件", terminalCount: 2 },
    ],
  });
  const result = validateElectricalAnalysis(analysis);
  assert.ok(
    result.warnings.some(w => w.includes("X9") && w.includes("不在符号库")),
    "X 前缀应告警",
  );
});

test("校验：symbol 未识别但类别与标号前缀一致时放行", () => {
  const analysis = baseAnalysis({
    components: [
      { ref: "R1", symbol: "unknown", category: "passive", name: "未知无源件", terminalCount: 2 },
      { ref: "C2", symbol: "unknown", category: "passive", name: "未知无源件", terminalCount: 2 },
    ],
  });
  const result = validateElectricalAnalysis(analysis);
  assert.ok(!result.warnings.some(w => w.includes("R1") && w.includes("不一致")), "R 前缀 + passive 类别应提示性放行");
  assert.equal(result.hasStructuralIssues, false);
});

test("校验：悬空网络与孤立元件告警", () => {
  const analysis = baseAnalysis({
    nets: [
      { name: "N1", connectedRefs: ["R1.2"] }, // 单引脚非电源网络 → 悬空提示
      { name: "EMPTY", connectedRefs: [] }, // 空网络 → 结构性错误
    ],
  });
  const result = validateElectricalAnalysis(analysis);
  assert.ok(
    result.warnings.some(w => w.includes("EMPTY")),
    "空网络应告警",
  );
  assert.ok(
    result.warnings.some(w => w.includes("N1") && w.includes("1 个引脚")),
    "单引脚非电源网络应提示悬空",
  );
  assert.ok(
    result.warnings.some(w => w.includes("C2") && w.includes("未出现在任何网络")),
    "未引用的两端元件应提示孤立",
  );
  assert.equal(result.hasStructuralIssues, true);
});

test("校验：网络引用不存在的元件告警", () => {
  const analysis = baseAnalysis({
    nets: [{ name: "N1", connectedRefs: ["R1.1", "Q3.2"] }], // Q3 不存在于 components
  });
  const result = validateElectricalAnalysis(analysis);
  assert.ok(result.warnings.some(w => w.includes("Q3") && w.includes("不存在的元件")));
  assert.equal(result.hasStructuralIssues, true);
});

test("校验：图文对齐——文字提及未识别元件告警", () => {
  const result = validateElectricalAnalysis(baseAnalysis(), "本电路包括电阻 R1、电容 C2 以及场效应管 Q5");
  assert.ok(
    result.warnings.some(w => w.includes("Q5") && w.includes("未识别")),
    "claim 提及 Q5 但附图未识别应告警",
  );
  // R1/C2 均被识别 → 不产生缺失告警
  assert.ok(!result.warnings.some(w => w.includes("R1") && w.includes("未识别")));
});

test("校验：附图识别但文字未提及为信息提示（非结构性错误）", () => {
  const result = validateElectricalAnalysis(baseAnalysis(), "一种电路装置");
  assert.ok(
    result.warnings.some(w => w.includes("R1") && w.includes("未提及")),
    "附图有而文字未提及应给信息提示",
  );
  assert.equal(result.hasStructuralIssues, false, "信息提示不应计为结构性问题");
});

test("extractClaimRefs：仅提取符号库已知前缀的标记", () => {
  const refs = extractClaimRefs("电路包括电阻 R1、电容 C2、芯片 IC3 和 2026 年申请的 D4");
  assert.ok(refs.includes("R1"));
  assert.ok(refs.includes("C2"));
  assert.ok(refs.includes("IC3"));
  assert.ok(!refs.some(r => r === "2026"), "纯数字不应被提取");
  assert.ok(refs.includes("D4"), "D 前缀（二极管）在符号库中，应提取");
});

test("extractClaimRefs：无上下文返回空", () => {
  assert.deepEqual(extractClaimRefs(undefined), []);
  assert.deepEqual(extractClaimRefs("   "), []);
});
