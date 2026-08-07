/**
 * src/patent/chemistry — SMILES 校验/规范化（RDKit WASM + 降级路径）测试。
 *
 * 含 G7 兜底路径用例：MinimalLib 未暴露 get_molecular_formula，分子式经
 * InChI 公式段提取（formulaFromInChI），正则元素计数（countElementsFromSmiles）
 * 与语法预检（isPlausibleSmilesSyntax）作为 RDKit 不可用时的降级校验。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  countElementsFromSmiles,
  formulaFromInChI,
  isPlausibleSmilesSyntax,
  isRdkitAvailable,
  validateSmiles,
} from "../../../src/patent/chemistry/index.js";

test("smiles: RDKit WASM 真实加载可用", async () => {
  assert.equal(await isRdkitAvailable(), true, "测试环境应能加载 @rdkit/rdkit WASM");
});

test("smiles: 合法 SMILES 校验通过并规范化", async () => {
  const result = await validateSmiles("CC(=O)OC1=CC=CC=C1C(=O)O");
  assert.equal(result.ok, true);
  // get_smiles() 重新生成即规范化（G7：无 get_canonical_smiles）
  assert.equal(result.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
  // 分子式经 InChI 公式段提取（G7：无 get_molecular_formula）
  assert.equal(result.formula, "C9H8O4");
  assert.ok(result.inchi?.startsWith("InChI=1S/C9H8O4"));
  assert.ok(result.inchikey, "应能计算 InChIKey");
});

test("smiles: 非法 SMILES 校验失败", async () => {
  const result = await validateSmiles("not_a_valid_smiles_###");
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0, "应返回失败原因");
});

test("smiles: 空输入直接失败", async () => {
  const result = await validateSmiles("   ");
  assert.equal(result.ok, false);
});

test("smiles: G7 兜底——formulaFromInChI 提取分子式", () => {
  assert.equal(formulaFromInChI("InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)"), "C9H8O4");
  assert.equal(formulaFromInChI("InChI=1S/CH4/h1H4"), "CH4");
  assert.equal(formulaFromInChI("not an inchi"), undefined);
});

test("smiles: G7 兜底——countElementsFromSmiles 元素计数（近似，仅显式原子）", () => {
  // 阿司匹林 SMILES：显式 C9、O4（隐氢不计入）
  assert.equal(countElementsFromSmiles("CC(=O)Oc1ccccc1C(=O)O"), "C9O4");
  assert.equal(countElementsFromSmiles("[Na+]Cl"), "ClNa");
  // 非元素字符（x/y/z 不在有机子集）→ 无法计数
  assert.equal(countElementsFromSmiles("xyzxyz"), undefined);
  assert.equal(countElementsFromSmiles(""), undefined);
});

test("smiles: G7 兜底——isPlausibleSmilesSyntax 语法预检", () => {
  assert.equal(isPlausibleSmilesSyntax("CC(=O)Oc1ccccc1C(=O)O"), true);
  assert.equal(isPlausibleSmilesSyntax("C1=CC=CC=C1"), true);
  assert.equal(isPlausibleSmilesSyntax(""), false);
  assert.equal(isPlausibleSmilesSyntax("包含中文的字符串"), false);
  assert.equal(isPlausibleSmilesSyntax("has space"), false);
  assert.equal(isPlausibleSmilesSyntax("123456"), false, "纯数字非 SMILES");
});

test("smiles: 评审 H2——畸形输入触发 WASM 异常时不抛出，归一为 ok=false", async () => {
  // 评审实测复现 memory access out of bounds 的三类输入
  const malformed = [
    "C\u0000C(=O)O", // NUL 字节
    `C1${"CC2(C1)C3C4C5C6".repeat(20)}`, // 复杂多环（近边界长度）
    `${"(".repeat(90)}${"C".repeat(90)}${")".repeat(90)}`, // 深度嵌套分支
  ];
  for (const input of malformed) {
    const result = await validateSmiles(input); // 不得 reject
    assert.equal(result.ok, false, `畸形输入应判非法：${input.slice(0, 16)}…`);
    assert.ok(result.error && result.error.length > 0, "应携带失败原因");
  }
});

test("smiles: 评审 L2——超长输入（>1024 字符）直接拒绝，不进入 WASM", async () => {
  const result = await validateSmiles("C".repeat(2000));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /过长/);
});
