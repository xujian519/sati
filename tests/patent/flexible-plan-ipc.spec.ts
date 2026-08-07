/**
 * src/patent/flexible-plan.ts — IPC 技术领域自动推断测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlexiblePlan,
  formatTechnicalField,
  inferTechnicalField,
  isElectricalCase,
  isElectricalIpc,
} from "../../src/patent/flexible-plan.js";
import type { IpcClassification } from "../../src/knowledge/patent/types.js";

test("formatTechnicalField: 含 detail 时输出部号+大类", () => {
  const c: IpcClassification = {
    section: "H",
    confidence: 0.9,
    matchedKeywords: ["电路", "集成电路"],
    detail: "H01",
    detailConfidence: 0.85,
  };
  assert.equal(formatTechnicalField(c), "H H01:电学-H01");
});

test("formatTechnicalField: 无 detail 时只输出部", () => {
  const c: IpcClassification = { section: "A", confidence: 0.82, matchedKeywords: ["医药"] };
  assert.equal(formatTechnicalField(c), "A:人类生活必需");
});

test("inferTechnicalField: 电学文本推断为 H 部", () => {
  const field = inferTechnicalField(
    "本发明涉及一种集成电路芯片和半导体电路，用于无线通信系统中的射频信号放大与调制解调。",
  );
  assert.ok(field, "应成功推断技术领域");
  assert.ok(field!.startsWith("H"), `应推断为 H 部，实际：${field}`);
});

test("inferTechnicalField: 空文本返回 undefined", () => {
  assert.equal(inferTechnicalField(""), undefined);
  assert.equal(inferTechnicalField("   "), undefined);
});

test("inferTechnicalField: 低置信度返回 undefined", () => {
  const fakeClassifier = (): IpcClassification => ({
    section: "B",
    confidence: 0.5,
    matchedKeywords: [],
  });
  assert.equal(inferTechnicalField("abc", fakeClassifier), undefined);
});

test("isElectricalIpc: 仅 H 部返回 true", () => {
  assert.equal(isElectricalIpc({ section: "H", confidence: 0.9, matchedKeywords: [] }), true);
  assert.equal(isElectricalIpc({ section: "h", confidence: 0.9, matchedKeywords: [] }), true);
  assert.equal(isElectricalIpc({ section: "G", confidence: 0.9, matchedKeywords: [] }), false);
});

test("isElectricalCase: 电学文本返回 true，非电学返回 false", () => {
  assert.equal(isElectricalCase("本发明提供一种射频通信模块，包括天线、功率放大器和调制解调器。"), true);
  assert.equal(isElectricalCase("本发明涉及机械齿轮传动装置。"), false);
  assert.equal(isElectricalCase(""), false);
});

test("createFlexiblePlan: 未指定 technicalField 时根据 inputText 自动推断", () => {
  const plan = createFlexiblePlan("case-001", "invalidation", {
    inputText: "本案涉及一种开关电源控制电路，包括变压器、MOSFET和反馈网络。",
  });
  assert.ok(plan.technicalField, "应自动设置 technicalField");
  assert.ok(plan.technicalField!.startsWith("H"), `应为 H 部：${plan.technicalField}`);
});

test("createFlexiblePlan: 显式 technicalField 优先于自动推断", () => {
  const plan = createFlexiblePlan("case-002", "invalidation", {
    inputText: "本案涉及一种开关电源控制电路。",
    technicalField: "G06:计算",
  });
  assert.equal(plan.technicalField, "G06:计算");
});

test("createFlexiblePlan: 无可推断文本且不指定 technicalField 时不设置该字段", () => {
  const plan = createFlexiblePlan("case-003", "invalidation", {});
  assert.equal(plan.technicalField, undefined);
});

test("createFlexiblePlan: 可注入 classifier", () => {
  const fakeClassifier = (): IpcClassification => ({
    section: "H",
    confidence: 0.95,
    matchedKeywords: ["电路"],
    detail: "H01",
    detailConfidence: 0.9,
  });
  const plan = createFlexiblePlan("case-004", "drafting", {
    inputText: "ignored",
    classifier: fakeClassifier,
  });
  assert.equal(plan.technicalField, "H H01:电学-H01");
});
