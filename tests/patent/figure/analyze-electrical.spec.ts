/**
 * src/patent/figure — 电学深度分析（Step3）测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { analyzePatentFigure } from "../../../src/patent/figure/analyze.js";
import { analyzeElectricalFigure, type FigureModelClient } from "../../../src/patent/figure/analyze-electrical.js";

const STEP1_CIRCUIT_JSON = JSON.stringify({
  figure_type: "circuit",
  overall_description: "一种电位采集装置的电路原理图",
  confidence: 0.92,
  notes: ["包含电源、信号调理与采集电路"],
});

const STEP2_CIRCUIT_JSON = JSON.stringify({
  components: [
    { ref_number: "1", name: "电源模块", kind: "electrical", description: "供电" },
    { ref_number: "2", name: "信号调理电路", kind: "electrical", description: "放大滤波" },
  ],
  connections: [{ source: "1", target: "2", kind: "electrical", description: "供电连接" }],
  figure_description: "图1是本发明实施例提供的电位采集装置的电路原理图；图中：1-电源模块；2-信号调理电路；",
  warnings: [],
});

const STEP3_JSON = JSON.stringify({
  electrical_components: [
    { ref: "R1", symbol: "resistor", category: "passive", name: "电阻", value: "10kΩ", terminal_count: 2 },
    { ref: "c2", symbol: "capacitor", category: "passive", name: "电容", value: "100μF", terminal_count: 2 },
    { ref: "R1", symbol: "resistor", category: "passive", name: "电阻", value: "10kΩ" }, // 重复，应去重
    { ref: "U3", symbol: "opamp", category: "ic", name: "运算放大器", terminal_count: 3 },
    { ref: "Q5", symbol: "transistor_bjt", category: "semiconductor", name: "三极管", terminal_count: 3 },
  ],
  nets: [
    { name: "VCC", connected_refs: ["R1.1"] },
    { name: "N1", connected_refs: ["R1.2", "C2.1", "U3.2"] },
    { name: "GND", connected_refs: ["C2.2", "U3.1"] },
    { name: " ", connected_refs: ["R1.1"] }, // 空名，应过滤
  ],
  netlist: "R1 1 2 10k\nC2 2 0 100u",
  warnings: ["右下角区域符号模糊"],
});

const BASE_INPUT = {
  imagePath: "circuit.png",
  imageBase64: "aGVsbG8=",
  imageMimeType: "image/png",
  imageBytes: 5,
  figureNumber: 1,
  overallDescription: "电位采集装置的电路原理图",
  claimContext: "一种电位采集装置，包括电阻 R1、电容 C2 与运算放大器 U3",
};

/** 构造 fake 模型：按 phase 返回对应 JSON（step1/step2/step3）。 */
function fakeModel(responder: (phase: string) => string): FigureModelClient & { requests: CanonicalModelRequest[] } {
  const requests: CanonicalModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      const phase = (request.metadata?.phase as string) ?? "step1";
      yield { type: "text_delta", text: responder(phase) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

test("analyzeElectricalFigure: 全流程产出规范化电学分析", async () => {
  const model = fakeModel(() => STEP3_JSON);
  const result = await analyzeElectricalFigure(BASE_INPUT, model);

  assert.ok(result.analysis, "应产出分析结果");
  const { components, nets } = result.analysis!;
  assert.equal(components.length, 4, "重复 R1 应去重");
  assert.ok(
    components.some(c => c.ref === "C2"),
    "标号应统一大写（c2 → C2）",
  );
  assert.equal(components.find(c => c.ref === "R1")?.value, "10kΩ");
  assert.equal(nets.length, 3, "空名网络应过滤");
  assert.ok(nets.some(n => n.name === "N1" && n.connectedRefs.includes("U3.2")));
  assert.equal(result.analysis!.netlist, "R1 1 2 10k\nC2 2 0 100u");
  // 模型 warnings + 校验 warnings 合并（Q5 前缀 Q→三极管，类别匹配不告警；R1 已在 claim 提及）
  assert.ok(result.warnings.some(w => w.includes("符号模糊")));
});

test("analyzeElectricalFigure: JSON 围栏输出可解析", async () => {
  const model = fakeModel(() => `\`\`\`json\n${STEP3_JSON}\n\`\`\``);
  const result = await analyzeElectricalFigure(BASE_INPUT, model);
  assert.ok(result.analysis);
  assert.equal(result.analysis!.components.length, 4);
});

test("analyzeElectricalFigure: 首次非 JSON 重试成功", async () => {
  let calls = 0;
  const model = fakeModel(() => {
    calls += 1;
    return calls === 1 ? "这不是 JSON" : STEP3_JSON;
  });
  const result = await analyzeElectricalFigure(BASE_INPUT, model);
  assert.ok(result.analysis);
  assert.equal(calls, 2, "应重试一次");
});

test("analyzeElectricalFigure: 解析失败降级返回警告而非抛出", async () => {
  const model = fakeModel(() => "完全不可解析的输出");
  const result = await analyzeElectricalFigure(BASE_INPUT, model);
  assert.equal(result.analysis, undefined);
  assert.ok(result.warnings.some(w => w.includes("Step3")));
});

test("analyzeElectricalFigure: 模型调用错误降级返回警告", async () => {
  const model: FigureModelClient = {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("网络中断")),
      }),
    }),
  };
  const result = await analyzeElectricalFigure(BASE_INPUT, model);
  assert.equal(result.analysis, undefined);
  assert.ok(result.warnings.some(w => w.includes("Step3")));
});

test("analyzePatentFigure 集成: circuit 类型触发 Step3 且结果携带 electrical", async () => {
  const model = fakeModel(phase => {
    if (phase === "step3") return STEP3_JSON;
    if (phase === "step2") return STEP2_CIRCUIT_JSON;
    return STEP1_CIRCUIT_JSON;
  });
  const result = await analyzePatentFigure({ ...BASE_INPUT, imagePath: "fig1.png" }, model);

  assert.equal(result.figureType, "circuit");
  assert.ok(result.electrical, "circuit 类型应产出电学深度分析");
  assert.equal(result.electrical!.components.length, 4);
  assert.equal(model.requests.length, 3, "应依次调用 step1/step2/step3");
  const step3Request = model.requests[2]!;
  assert.equal(step3Request.metadata?.phase, "step3");
  // 提示词应注入符号库上下文
  const promptText = (step3Request.messages[0]!.content[0] as { text: string }).text;
  assert.ok(promptText.includes("电学符号标准集"), "Step3 提示词应含符号库上下文");
  assert.ok(promptText.includes("电阻"), "Step3 提示词应含符号条目");
});

test("analyzePatentFigure 集成: 非电路类型不触发 Step3", async () => {
  const model = fakeModel(phase => {
    if (phase === "step2") return STEP2_CIRCUIT_JSON;
    return JSON.stringify({
      figure_type: "structure",
      overall_description: "结构示意图",
      confidence: 0.9,
    });
  });
  const result = await analyzePatentFigure({ ...BASE_INPUT, imagePath: "fig1.png" }, model);
  assert.equal(result.figureType, "structure");
  assert.equal(result.electrical, undefined, "非电路类型不应产出电学分析");
  assert.equal(model.requests.length, 2, "只应调用 step1/step2");
});
