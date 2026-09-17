/**
 * src/patent/figuregen — P1 校验规则（V5/V7/V8/V9）表驱动测试。
 *
 * V5 禁注释（细则 21 条尾款[待核对]）：label 疑似注释性长文 → warn
 * V7 缩小三分之二可辨（指南一部一章 4.3，官方已核验）：介质锚定——画幅超出 A4
 *   可印区（会被分页切断）→ fail；打印字高低于最小可辨字高 → warn
 * V8 摘要附图（指南一部一章 4.5.2）：多图应指定恰好一幅
 * V9 实用新型必须有附图（指南一部二章 7.3 + 细则 20.5）
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function minimal(figureNo: number, label = "模块(10)", ref?: number): FigureSpec {
  return {
    figure_no: figureNo,
    kind: "flowchart",
    nodes: [{ id: `f${figureNo}-a`, label, ...(ref === undefined ? {} : { ref }) }],
    edges: [],
  };
}

test("V5 禁注释：超长单行 label → WARN；正常 label 不触发", () => {
  const longLabel = "本模块用于在接收到外部输入数据之后首先对数据进行格式校验，随后按照预设规则完成规范化处理并输出";
  const warned = checkFigures([minimal(1, longLabel, 10)], "模块(10)。");
  const v5 = warned.findings.filter(f => f.rule === "V5");
  assert.equal(v5.length, 1);
  assert.equal(v5[0].severity, "warn");
  assert.ok(v5[0].evidence?.some(e => e.includes("f1-a")));

  const clean = checkFigures([minimal(1, "处理模块(10)", 10)], "处理模块(10)。");
  assert.deepEqual(
    clean.findings.filter(f => f.rule === "V5"),
    [],
  );
});

test("V5 禁注释：多行段落式 label（>3 行）→ WARN", () => {
  const multiLine = "第一行\n第二行\n第三行\n第四行备注说明文字";
  const result = checkFigures([minimal(1, multiLine)], "");
  assert.ok(result.findings.some(f => f.rule === "V5" && f.severity === "warn"));
});

/** TB 链式流程图（n 步）：高度只取决于步数与布局常量，与标签字宽无关。 */
function chain(n: number, figureNo = 1): FigureSpec {
  return {
    figure_no: figureNo,
    kind: "flowchart",
    direction: "TB",
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `步骤${i + 1}` })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  };
}

test("V7 介质锚定：TB 链式流程图 ≥9 步超出 A4 可印高 → FAIL(page_fit)；8 步通过", () => {
  // 8 步 ≈ 239mm 可印（257mm 内）；9 步 ≈ 268mm 必被分页切断。
  const eight = checkFigures([chain(8)], "");
  assert.deepEqual(
    eight.findings.filter(f => f.rule === "V7"),
    [],
  );
  assert.ok(eight.ok, "8 步流程图应通过全部规则");

  for (const steps of [9, 12, 16]) {
    const result = checkFigures([chain(steps)], "");
    const v7 = result.findings.filter(f => f.rule === "V7" && f.metric === "page_fit");
    assert.equal(v7.length, 1, `${steps} 步应报一条 page_fit`);
    assert.equal(v7[0].severity, "fail");
    assert.match(v7[0].message, /mm/u, "证据须给出纸面毫米而非像素");
    assert.deepEqual(v7[0].figure_nos, [1]);
    assert.equal(result.ok, false);
  }
});

test("V7 介质锚定：宽图超出可印宽 → FAIL(page_fit)", () => {
  const wide: FigureSpec = {
    figure_no: 1,
    kind: "block",
    direction: "LR",
    nodes: Array.from({ length: 24 }, (_, i) => ({ id: `w${i}`, label: "处理模块(10)" })),
    edges: [],
  };
  const result = checkFigures([wide], "");
  const pageFit = result.findings.filter(f => f.rule === "V7" && f.metric === "page_fit");
  assert.equal(pageFit.length, 1);
  assert.equal(pageFit[0].severity, "fail");
  assert.equal(result.ok, false);
});

test("V7 介质锚定：打印字高低于最小可辨字高 → WARN(font_size) 并给出缩 2/3 后字高", () => {
  // 20 步 ≈ 585mm 高：统一缩放系数下字高落到阈值以下（page_fit 同时触发）。
  const result = checkFigures([chain(20)], "");
  const font = result.findings.filter(f => f.rule === "V7" && f.metric === "font_size");
  assert.equal(font.length, 1);
  assert.equal(font[0].severity, "warn");
  assert.match(font[0].message, /mm/u);
  assert.ok(
    font[0].evidence?.some(e => /再缩 2\/3/u.test(e)),
    "证据须报出再缩 2/3 后的字高",
  );

  const small = checkFigures([minimal(1)], "");
  assert.deepEqual(
    small.findings.filter(f => f.rule === "V7"),
    [],
    "小图不触发 V7",
  );
});

test("V7 介质锚定：统一缩放——大图存在时同文档小图按同一系数判字高", () => {
  // 逐图独立缩放会高估小图字高；统一系数下小图也须按文档系数判定（诚实报出）。
  const result = checkFigures([minimal(1), chain(20, 2)], "");
  const fontWarnNos = result.findings
    .filter(f => f.rule === "V7" && f.metric === "font_size")
    .flatMap(f => f.figure_nos ?? []);
  assert.deepEqual(
    [...new Set(fontWarnNos)].sort((a, b) => a - b),
    [1, 2],
  );
});

test("V8 摘要附图：多图未指定/指定多幅 → WARN；恰好一幅 → 通过；单图不提示", () => {
  const none = checkFigures([minimal(1), minimal(2)], "");
  assert.ok(none.findings.some(f => f.rule === "V8" && f.severity === "warn"));

  const multiple = checkFigures(
    [
      { ...minimal(1), abstract: true },
      { ...minimal(2), abstract: true },
    ],
    "",
  );
  assert.ok(multiple.findings.some(f => f.rule === "V8" && f.severity === "warn"));

  const exact = checkFigures([{ ...minimal(1), abstract: true }, minimal(2)], "");
  assert.deepEqual(
    exact.findings.filter(f => f.rule === "V8"),
    [],
  );

  const single = checkFigures([minimal(1)], "");
  assert.deepEqual(
    single.findings.filter(f => f.rule === "V8"),
    [],
  );
});

test("V9 实用新型必须有附图：空附图集 → FAIL；有附图 → 不触发；发明不受影响", () => {
  const utilityNone = checkFigures([], "", { documentKind: "utility" });
  const v9 = utilityNone.findings.filter(f => f.rule === "V9");
  assert.equal(v9.length, 1);
  assert.equal(v9[0].severity, "fail");
  assert.ok(v9[0].message.includes("实用新型"));

  const utilitySome = checkFigures([minimal(1, "模块(10)", 10)], "模块(10)。", { documentKind: "utility" });
  assert.deepEqual(
    utilitySome.findings.filter(f => f.rule === "V9"),
    [],
  );

  const inventionNone = checkFigures([], "", { documentKind: "invention" });
  assert.deepEqual(
    inventionNone.findings.filter(f => f.rule === "V9"),
    [],
  );
});

test("skipTextRules 时 V2/V3 跳过但 V5/V7/V8/V9 仍生效", () => {
  const result = checkFigures([minimal(1, "处理模块(20)", 20)], "", {
    skipTextRules: true,
    documentKind: "invention",
  });
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V2" || f.rule === "V3"),
    [],
  );
  assert.ok(result.ok, "结构规则全过时 ok");
});
