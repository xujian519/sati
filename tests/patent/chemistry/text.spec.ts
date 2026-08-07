/**
 * src/patent/chemistry — 文本化学实体提取测试（三级流水线第一级：正则候选）。
 *
 * G3 反例覆盖：C1-C6 范围写法、C12 章节号、式(I) 引用、纯英文单词、
 * 纯数字温度范围均不应被误判为化学实体。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  extractChemicalCandidates,
  extractFormulaCandidates,
  extractSmilesCandidates,
  isValidHillFormula,
} from "../../../src/patent/chemistry/index.js";

test("text: 分子式提取（Hill 序，≥2 种元素）", () => {
  const text = "实施例中加入C6H12O6（葡萄糖），并用H2SO4酸化，得到NaCl与C2H5OH，催化剂为CO2。";
  const formulas = extractFormulaCandidates(text);
  assert.ok(formulas.includes("C6H12O6"));
  assert.ok(formulas.includes("H2SO4"));
  assert.ok(formulas.includes("NaCl"));
  assert.ok(formulas.includes("C2H5OH"));
  assert.ok(formulas.includes("CO2"));
});

test("text: 纯烃分子式（CH4/C2H6）可提取", () => {
  const formulas = extractFormulaCandidates("甲烷CH4与乙烷C2H6按体积比1:2混合，反应生成C12H26。");
  assert.ok(formulas.includes("CH4"));
  assert.ok(formulas.includes("C2H6"));
  assert.ok(formulas.includes("C12H26"));
});

test("text: G3 反例——排除 C1-C6 范围、C12 章节号、式(I) 引用", () => {
  const text = "所述烷基为C1-C6直链烷基；具体实施例见C12；如式(I)所示化合物；含N2气氛。";
  const formulas = extractFormulaCandidates(text);
  assert.ok(!formulas.includes("C1"), "C1 为范围写法");
  assert.ok(!formulas.includes("C6"), "C6 为范围写法");
  assert.ok(!formulas.includes("C12"), "C12 为章节号");
  assert.ok(!formulas.includes("I"), "式(I) 中的罗马数字不应提取");
  assert.ok(!formulas.includes("N2"), "单元素分子式排除（避免噪声）");
});

test("text: SMILES 候选提取（结构要素启发式）", () => {
  const text = "化合物结构为 CC(=O)Oc1ccccc1C(=O)O（阿司匹林），另一候选为 C1=CC=CC=C1。";
  const tokens = extractSmilesCandidates(text);
  assert.ok(tokens.includes("CC(=O)Oc1ccccc1C(=O)O"));
  assert.ok(tokens.includes("C1=CC=CC=C1"));
});

test("text: G3 反例——纯英文单词/纯数字/分子式不应判为 SMILES", () => {
  const text = "the present invention provides a method at 25-30℃ with formula C6H12O6. 实施例编号为 2026-08-07。";
  const tokens = extractSmilesCandidates(text);
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("invention"));
  assert.ok(!tokens.includes("provides"));
  assert.ok(!tokens.includes("method"));
  assert.ok(!tokens.includes("25-30"));
  assert.ok(!tokens.includes("2026-08-07"));
  assert.ok(!tokens.includes("C6H12O6"), "分子式不属于 SMILES 候选");
});

test("text: 统一入口去重保序", () => {
  const { formulas, smilesTokens } = extractChemicalCandidates(
    "CC(=O)Oc1ccccc1C(=O)O 与 C6H12O6，重复的 CC(=O)Oc1ccccc1C(=O)O 只保留一次。",
  );
  assert.equal(formulas.filter(f => f === "C6H12O6").length, 1);
  assert.equal(smilesTokens.filter(s => s === "CC(=O)Oc1ccccc1C(=O)O").length, 1);
});

test("text: 评审 M3——生物医药缩略词不误提为分子式（真实元素校验）", () => {
  const text = "检测 T 细胞表面 CD4、CD8、CD20 表达，测定 ATP、DNA、RNA、TNF、IL2、HLA 水平；受试者曾感染 COVID-19。";
  const formulas = extractFormulaCandidates(text);
  for (const token of ["CD4", "CD8", "CD20", "ATP", "DNA", "RNA", "TNF", "IL2", "HLA", "COVID"]) {
    assert.ok(!formulas.includes(token), `${token} 不应被提取为分子式`);
  }
});

test("text: 评审 M4——M2=5、ratio=2 等非化学词元不误提为 SMILES", () => {
  const text = "压力计读数为 M2=5，配比 ratio=2；有效候选 CC(=O)O 与方括号原子 [Na+]Cl 应保留。";
  const tokens = extractSmilesCandidates(text);
  assert.ok(!tokens.includes("M2=5"), "M 非真实元素，M2=5 不应提取");
  assert.ok(!tokens.includes("ratio=2"), "ratio=2 不应提取");
  assert.ok(tokens.includes("CC(=O)O"));
  assert.ok(tokens.includes("[Na+]Cl"), "方括号原子开头的合法 SMILES 应保留");
});

test("text: isValidHillFormula——防幻觉 H1 分子式硬校验", () => {
  assert.equal(isValidHillFormula("C9H8O4"), true);
  assert.equal(isValidHillFormula("NaCl"), true);
  assert.equal(isValidHillFormula("C6H12O6"), true);
  assert.equal(isValidHillFormula("ABC!@#"), false, "垃圾字符不得通过");
  assert.equal(isValidHillFormula("XYZ123"), false, "非真实元素符号不得通过");
  assert.equal(isValidHillFormula("C"), false, "单元素写法排除");
  assert.equal(isValidHillFormula(""), false);
  assert.equal(isValidHillFormula("  H2O  "), true, "允许首尾空白");
});
