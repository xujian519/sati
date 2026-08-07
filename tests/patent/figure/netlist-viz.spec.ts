/**
 * src/patent/figure/netlist-viz.ts — 电学网表可视化测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElectricalAnalysis } from "../../../src/patent/figure/types.js";
import {
  formatElectricalSummary,
  mermaidId,
  renderElectricalNetlistMermaid,
  renderElectricalNetlistSvg,
} from "../../../src/patent/figure/netlist-viz.js";

const SAMPLE: ElectricalAnalysis = {
  components: [
    { ref: "R1", symbol: "resistor", category: "passive", name: "电阻", value: "10kΩ", terminalCount: 2 },
    { ref: "C1", symbol: "capacitor", category: "passive", name: "电容", value: "100nF", terminalCount: 2 },
    { ref: "U1", symbol: "ic_chip", category: "ic", name: "芯片", terminalCount: 8 },
  ],
  nets: [
    { name: "N1", connectedRefs: ["R1.1", "C1.1"] },
    { name: "GND", connectedRefs: ["R1.2", "U1.4"] },
    { name: "VCC", connectedRefs: ["U1.8"] },
  ],
  netlist: ".SUBCKT sample\nR1 N1 GND 10k\nC1 N1 GND 100n\n.ENDS",
};

test("mermaidId 合法化特殊字符", () => {
  assert.equal(mermaidId("R1"), "n_R1");
  assert.equal(mermaidId("U1.2"), "n_U1_2");
});

test("renderElectricalNetlistMermaid: 生成 flowchart 并包含元件与网络", () => {
  const mmd = renderElectricalNetlistMermaid(SAMPLE);
  assert.ok(mmd.startsWith("flowchart LR"));
  assert.ok(mmd.includes('n_R1["R1\\n电阻\\n10kΩ"]'));
  assert.ok(mmd.includes('n_C1["C1\\n电容\\n100nF"]'));
  assert.ok(mmd.includes('n_N1(("N1"))'));
  assert.ok(mmd.includes("n_R1 --- n_N1"));
  assert.ok(mmd.includes("class n_VCC powerNet"));
});

test("renderElectricalNetlistMermaid: 空元件时返回占位", () => {
  const mmd = renderElectricalNetlistMermaid({ components: [], nets: [] });
  assert.ok(mmd.includes("空电路图"));
});

test("formatElectricalSummary: 输出元件/网络/网表摘要", () => {
  const summary = formatElectricalSummary(SAMPLE);
  assert.ok(summary.includes("元件数量：3"));
  assert.ok(summary.includes("R1：电阻"));
  assert.ok(summary.includes("N1：R1.1, C1.1"));
  assert.ok(summary.includes(".SUBCKT sample"));
});

test("renderElectricalNetlistSvg: 生成 SVG 并包含元件矩形与连线", () => {
  const svg = renderElectricalNetlistSvg(SAMPLE);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes("<rect"));
  assert.ok(svg.includes(">R1<"));
  assert.ok(svg.includes(">N1<"));
});

test("renderElectricalNetlistSvg: 空元件返回提示 SVG", () => {
  const svg = renderElectricalNetlistSvg({ components: [], nets: [] });
  assert.ok(svg.includes("无元件"));
});
