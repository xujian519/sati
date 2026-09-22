/**
 * src/patent/figuregen/check — 图号义务与字高法域化测试（W1-4：V7 按法域 + V15/V16/V17）。
 *
 * 关键取舍在测试里锁住：
 * - V15/V16 只在**交付形态可观测**时判（调用方给 numberedFigureNos），结构化 spec 不判；
 * - V16 只对 pct/us（CN 指南 4.3 未禁止单幅编号）；
 * - V7 的字高下限按法域档案取（CN 实践下限 2.0mm、PCT/US 条文 3.2mm），报告须写明来源性质；
 * - pct 跳过 V8/V9/V10/V11 并如实声明（不把 CN 条文伪装成 PCT 条文）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import { layoutFigure } from "../../../src/patent/figuregen/layout.js";
import { officeProfile } from "../../../src/patent/figuregen/office-profile.js";
import { FIGURE_FONT_SIZE } from "../../../src/patent/figuregen/metrics.js";
import { pxToMm, uniformFigureZoom } from "../../../src/patent/figuregen/page-contract.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

/** n 个节点的纵向链（用于把画幅撑到需要缩放，测字高下限分支）。 */
function chain(count: number, figureNo = 1): FigureSpec {
  return {
    figure_no: figureNo,
    kind: "flowchart",
    nodes: Array.from({ length: count }, (_unused, index) => ({
      id: `n${index}`,
      label: `步骤${index}`,
      ...(index === 0 ? { shape: "ellipse" as const } : {}),
    })),
    edges: Array.from({ length: count - 1 }, (_unused, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
  };
}

function pair(): FigureSpec[] {
  return [chain(12, 1), chain(12, 2)];
}

function printedFontMm(office: "cnipa" | "pct" | "uspto"): number {
  const sizes = pair().map(figure => {
    const layout = layoutFigure(figure, { caption: true });
    return { widthMm: pxToMm(layout.width), heightMm: pxToMm(layout.height) };
  });
  return pxToMm(FIGURE_FONT_SIZE) * uniformFigureZoom(sizes, officeProfile(office));
}

test("V15：多幅却有一幅未标注图号 → fail（仅在交付形态可观测时判）", () => {
  const figures = [chain(3, 1), chain(3, 2)];
  const observed = checkFigures(figures, "", {
    skipTextRules: true,
    figureCount: 2,
    numberedFigureNos: [1],
  });
  const v15 = observed.findings.filter(f => f.rule === "V15");
  assert.equal(v15.length, 1);
  assert.equal(v15[0].severity, "fail");
  assert.deepEqual(v15[0].figure_nos, [2]);
  assert.match(v15[0].message, /共 2 幅/u);

  // 两幅都有图号 → 不报
  const both = checkFigures(figures, "", { skipTextRules: true, figureCount: 2, numberedFigureNos: [1, 2] });
  assert.deepEqual(
    both.findings.filter(f => f.rule === "V15"),
    [],
  );

  // 未给观测（结构化 spec 路径）→ 不判（不猜渲染器应该怎么写）
  const unobserved = checkFigures(figures, "", { skipTextRules: true, figureCount: 2 });
  assert.deepEqual(
    unobserved.findings.filter(f => f.rule === "V15" || f.rule === "V16"),
    [],
  );
});

test("V16：单幅却标注图号 → pct/us 报 warn；CN 不判（4.3 未禁止单幅编号）", () => {
  const single = [chain(3, 1)];
  for (const jurisdiction of ["pct", "us"] as const) {
    const result = checkFigures(single, "", {
      skipTextRules: true,
      jurisdiction,
      figureCount: 1,
      numberedFigureNos: [1],
    });
    const v16 = result.findings.filter(f => f.rule === "V16");
    assert.equal(v16.length, 1, `${jurisdiction} 单幅带图号应报 V16`);
    assert.equal(v16[0].severity, "warn");
    assert.ok(
      jurisdiction === "us" ? v16[0].message.includes("FIG.") : v16[0].message.includes("Fig."),
      v16[0].message,
    );
  }
  const cn = checkFigures(single, "", { skipTextRules: true, figureCount: 1, numberedFigureNos: [1] });
  assert.deepEqual(
    cn.findings.filter(f => f.rule === "V16"),
    [],
    "CN 单幅编号合法，不判",
  );
});

test("V17：多页附图未声明页码/页码越界 → warn；成对且合法不报", () => {
  const figures = [chain(3, 1)];
  const missing = checkFigures(figures, "", { skipTextRules: true, sheetTotal: 3 });
  const v17 = missing.findings.filter(f => f.rule === "V17");
  assert.equal(v17.length, 1);
  assert.equal(v17[0].severity, "warn");
  assert.match(v17[0].evidence?.[0] ?? "", /未声明附图页序号/u);
  assert.match(v17[0].evidence?.[0] ?? "", /写作 1/u, "CN 体例为顺序数字");

  const outOfRange = checkFigures(figures, "", { skipTextRules: true, sheetIndex: 5, sheetTotal: 3 });
  assert.equal(outOfRange.findings.filter(f => f.rule === "V17").length, 1);

  const valid = checkFigures(figures, "", { skipTextRules: true, sheetIndex: 2, sheetTotal: 3 });
  assert.deepEqual(
    valid.findings.filter(f => f.rule === "V17"),
    [],
  );

  // 未声明页数（单页案卷）→ 不判
  const singleSheet = checkFigures(figures, "", { skipTextRules: true });
  assert.deepEqual(
    singleSheet.findings.filter(f => f.rule === "V17"),
    [],
  );
});

test("V7 字高下限按法域：同一张图在 CN 通过、在 uspto 报 warn（2.0mm vs 3.2mm）", () => {
  const cnipaPrinted = printedFontMm("cnipa");
  const usptoPrinted = printedFontMm("uspto");
  // 测试前提自检：这张图的打印字高正落在两个下限之间，才谈得上"按法域判"
  assert.ok(cnipaPrinted > 2.0 && cnipaPrinted < 3.2, `cnipa 字高 ${cnipaPrinted.toFixed(2)}mm 应落在 (2.0, 3.2)`);
  assert.ok(usptoPrinted < 3.2, `uspto 字高 ${usptoPrinted.toFixed(2)}mm 应低于 3.2mm`);

  const cn = checkFigures(pair(), "", { skipTextRules: true });
  assert.deepEqual(
    cn.findings.filter(f => f.rule === "V7" && f.metric === "font_size"),
    [],
    "CN 用实践下限 2.0mm，此图不告警",
  );

  const us = checkFigures(pair(), "", { skipTextRules: true, jurisdiction: "us" });
  const usFont = us.findings.filter(f => f.rule === "V7" && f.metric === "font_size");
  assert.equal(usFont.length, 2, "两幅都应报字高不足");
  assert.equal(usFont[0].severity, "warn");
  assert.match(usFont[0].message, /最小字高 3\.2mm/u);
  assert.ok(!usFont[0].message.includes("实践下限"), "条文数值不得标注为实践下限");

  // CN 若真低于 2.0mm，报告须写明"实践下限（非法条数值）"
  const tiny = [chain(60, 1)];
  const cnTiny = checkFigures(tiny, "", { skipTextRules: true });
  const cnFont = cnTiny.findings.filter(f => f.rule === "V7" && f.metric === "font_size");
  assert.equal(cnFont.length, 1);
  assert.match(cnFont[0].message, /实践下限，非法条数值/u);
});

test("pct：跳过 V8/V9/V10/V11 并如实声明（不把 CN 条文伪装成 PCT 条文）", () => {
  // 带附图标记的两幅图（V10 需要图内有标记才能真正判定，否则该规则整体不生效）
  const refFigure = (figureNo: number, ref: number): FigureSpec => ({
    figure_no: figureNo,
    kind: "flowchart",
    nodes: [
      { id: `f${figureNo}-a`, label: "开始", shape: "ellipse" },
      { id: `f${figureNo}-b`, label: `处理模块(${ref})`, ref },
    ],
    edges: [{ from: `f${figureNo}-a`, to: `f${figureNo}-b` }],
  });
  const figures = [refFigure(1, 20), refFigure(2, 30)];
  const text = "1. 一种装置，包括处理模块20。\n\n具体实施方式：处理模块(20)连接电源。";
  const faces = { claims: "1. 一种装置，包括处理模块20。", description: "具体实施方式：处理模块(20)连接电源。" };

  const cn = checkFigures(figures, text, { documentKind: "utility", jurisdiction: "cn", faces });
  assert.ok(
    cn.findings.some(f => f.rule === "V8"),
    "CN 多图未指定摘要附图应报 V8",
  );
  assert.ok(
    cn.findings.some(f => f.rule === "V10"),
    "CN 权利要求裸标记应报 V10",
  );

  const pct = checkFigures(figures, text, { documentKind: "utility", jurisdiction: "pct", faces });
  assert.deepEqual(
    pct.findings.filter(f => ["V8", "V9", "V10", "V11"].includes(f.rule)),
    [],
    "pct 下这四条整族跳过（即便调用方显式分面）",
  );
  assert.equal(pct.bracketRules?.applied, false);
  assert.match(pct.bracketRules?.reason ?? "", /pct 未适用 CN 括号规则/u);

  // us 仍判 V10（权利要求裸标记），且不出现 bracketRules 声明
  const us = checkFigures(figures, text, { documentKind: "utility", jurisdiction: "us", faces });
  assert.ok(
    us.findings.some(f => f.rule === "V10"),
    "us 仍适用权利要求括号规则",
  );
  assert.equal(us.bracketRules, undefined);
});

test("pct：图面用语规则的法域适用性与 cn/us 一致（V13 仅 cn、V14 括号仅非 cn）", () => {
  const figures = [
    {
      figure_no: 1,
      kind: "flowchart" as const,
      nodes: [
        { id: "a", label: "Input Sensor" },
        { id: "b", label: "处理模块(20)", ref: 20 },
      ],
      edges: [],
    },
  ];
  const pct = checkFigures(figures, "", { skipTextRules: true, jurisdiction: "pct", figureCount: 2 });
  assert.ok(!pct.findings.some(f => f.rule === "V13"), "pct 不判非中文词语");
  assert.ok(
    pct.findings.some(f => f.rule === "V14"),
    "pct 判标号与括号连用",
  );
});

test("V15 依据按法域引用（CN 指南 4.3 / PCT 11.13(k) / 37 CFR 1.84(u)(1)）", () => {
  const figures = [chain(3, 1), chain(3, 2)];
  const pick = (jurisdiction: "cn" | "us" | "pct"): string => {
    const result = checkFigures(figures, "", {
      skipTextRules: true,
      jurisdiction,
      figureCount: 2,
      numberedFigureNos: [],
    });
    return result.findings.find(f => f.rule === "V15")?.message ?? "";
  };
  assert.match(pick("cn"), /指南一部一章 4\.3/u);
  assert.match(pick("us"), /37 CFR 1\.84\(u\)\(1\)/u);
  assert.match(pick("pct"), /PCT Rule 11\.13\(k\)/u);
});
