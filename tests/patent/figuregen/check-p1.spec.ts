/**
 * src/patent/figuregen — P1 校验规则（V5/V7/V8/V9）表驱动测试。
 *
 * V5 禁注释（细则 21 条尾款[待核对]）：label 疑似注释性长文 → warn
 * V7 缩小三分之二可辨（指南[待核对]）：布局画幅超限 → warn（建议拆图）
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

test("V7 可辨度：链式大图画幅超限 → WARN；小图不触发", () => {
  const big: FigureSpec = {
    figure_no: 1,
    kind: "flowchart",
    direction: "TB",
    nodes: Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, label: `步骤${i + 1}` })),
    edges: Array.from({ length: 23 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
  };
  const result = checkFigures([big], "");
  const v7 = result.findings.filter(f => f.rule === "V7");
  assert.equal(v7.length, 1);
  assert.equal(v7[0].severity, "warn");

  const small = checkFigures([minimal(1)], "");
  assert.deepEqual(
    small.findings.filter(f => f.rule === "V7"),
    [],
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
