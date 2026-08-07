/**
 * scripts/figure-benchmark/run.ts — 基准运行器指标计算测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeElectricalMetrics, computeRefMetrics, summarize } from "../../../scripts/figure-benchmark/run.js";
import type { FigureAnalysisResult, FigureComponent } from "../../../src/patent/figure/types.js";

function makeFigureResult(
  overrides: {
    predicted?: Partial<FigureAnalysisResult>;
    error?: string;
    metrics?: Partial<{
      typeCorrect: boolean;
      refPrecision: number;
      refRecall: number;
      refF1: number;
      usable: boolean;
      confidence: number;
      electrical?: { symbolAccuracy: number; netlistValid: boolean; hasElectrical: boolean };
    }>;
  } = {},
) {
  const baseComponents: FigureComponent[] = [
    { refNumber: "R1", name: "电阻", kind: "electrical", description: "" },
    { refNumber: "C2", name: "电容", kind: "electrical", description: "" },
  ];
  return {
    id: "test",
    imageFile: "test.png",
    figureNumber: 1,
    humanFigureType: "circuit" as const,
    predicted: overrides.error
      ? null
      : ({
          imagePath: "test.png",
          figureNumber: 1,
          figureType: "circuit",
          overallDescription: "测试",
          components: baseComponents,
          connections: [],
          figureDescription: "图1是测试电路",
          confidence: 0.9,
          warnings: [],
          usable: true,
          modelUsed: "test/test",
          ...overrides.predicted,
        } satisfies FigureAnalysisResult),
    error: overrides.error,
    metrics: {
      typeCorrect: true,
      expectedRefCount: 2,
      predictedRefCount: 2,
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      refPrecision: 1,
      refRecall: 1,
      refF1: 1,
      usable: true,
      confidence: 0.9,
      ...overrides.metrics,
    },
    durationMs: 10,
  };
}

test("computeRefMetrics: 命中、误报、漏报计算正确", () => {
  const m = computeRefMetrics(["R1", "C2", "U3"], [
    { refNumber: "R1", name: "电阻", kind: "electrical", description: "" },
    { refNumber: "D4", name: "二极管", kind: "electrical", description: "" },
  ] as FigureComponent[]);
  assert.equal(m.truePositives, 1);
  assert.equal(m.falsePositives, 1); // D4
  assert.equal(m.falseNegatives, 2); // C2, U3
  assert.equal(m.refPrecision, 0.5);
  assert.equal(m.refRecall, 1 / 3);
});

test("computeElectricalMetrics: 无 ground truth 返回 undefined", () => {
  const figure = {
    expectedElectrical: undefined,
  } as unknown as Parameters<typeof computeElectricalMetrics>[0];
  const predicted = { electrical: { components: [], nets: [] } } as unknown as FigureAnalysisResult;
  assert.equal(computeElectricalMetrics(figure, predicted), undefined);
});

test("computeElectricalMetrics: 符号准确率按 ref 匹配 symbol", () => {
  const figure = {
    expectedElectrical: {
      components: [
        { ref: "R1", symbol: "resistor" },
        { ref: "C2", symbol: "capacitor" },
        { ref: "U3", symbol: "opamp" },
      ],
      nets: [],
    },
  } as unknown as Parameters<typeof computeElectricalMetrics>[0];
  const predicted = {
    electrical: {
      components: [
        { ref: "R1", symbol: "resistor" },
        { ref: "C2", symbol: "resistor" }, // 符号识别错误
        // U3 缺失
      ],
      nets: [{ name: "N1", connectedRefs: ["R1.1", "C2.1"] }],
    },
  } as unknown as FigureAnalysisResult;
  const m = computeElectricalMetrics(figure, predicted)!;
  assert.equal(m.hasElectrical, true);
  assert.equal(m.symbolAccuracy, 1 / 3);
  assert.equal(m.netlistValid, true); // nets 非空且引用有效
});

test("computeElectricalMetrics: 无 electrical 结果时产出率 0", () => {
  const figure = {
    expectedElectrical: {
      components: [{ ref: "R1", symbol: "resistor" }],
      nets: [],
    },
  } as unknown as Parameters<typeof computeElectricalMetrics>[0];
  const predicted = { electrical: undefined } as unknown as FigureAnalysisResult;
  const m = computeElectricalMetrics(figure, predicted)!;
  assert.equal(m.hasElectrical, false);
  assert.equal(m.symbolAccuracy, 0);
  assert.equal(m.netlistValid, false);
});

test("computeElectricalMetrics: netlist 结构校验识别悬空网络", () => {
  const figure = {
    expectedElectrical: { components: [{ ref: "R1", symbol: "resistor" }], nets: [] },
  } as unknown as Parameters<typeof computeElectricalMetrics>[0];
  const predicted = {
    electrical: {
      components: [{ ref: "R1", symbol: "resistor" }],
      nets: [{ name: "N1", connectedRefs: ["R1.1"] }], // 单引脚非电源网络
    },
  } as unknown as FigureAnalysisResult;
  const m = computeElectricalMetrics(figure, predicted)!;
  assert.equal(m.netlistValid, false);
});

test("summarize: 平均包含电学指标", () => {
  const result1 = makeFigureResult({
    metrics: {
      electrical: { hasElectrical: true, symbolAccuracy: 0.8, netlistValid: true },
    },
  });
  const result2 = makeFigureResult({
    metrics: {
      electrical: { hasElectrical: true, symbolAccuracy: 0.6, netlistValid: false },
    },
  });
  const summary = summarize([result1, result2]);
  assert.equal(summary.electricalRate, 1);
  assert.equal(summary.avgSymbolAccuracy, 0.7);
  assert.equal(summary.netlistValidRate, 0.5);
});
