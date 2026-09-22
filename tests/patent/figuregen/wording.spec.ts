/**
 * src/patent/figuregen — 图面用语规则 V12/V13/V14 测试（W0-2）。
 *
 * 一半用例是**防误伤**断言（全大写缩写、单位、括号注明原文、大写字母后缀、步骤标号、
 * 式(1)/步骤(1) 类编号），因为这三条规则的价值取决于"报出来的都是真缺陷"——误报会把
 * 真缺陷淹掉（依据与有意不判项见 `wording-rules.ts` 头注）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WORDING_EVIDENCE_MAX, checkFigures } from "../../../src/patent/figuregen/check.js";
import {
  inspectWording,
  scanFigureWording,
  type WordingIssueKind,
} from "../../../src/patent/figuregen/wording-rules.js";
import type { FigureSpec, Jurisdiction } from "../../../src/patent/figuregen/types.js";

/** 单段图面词语在该法域下命中的类别（去重）。 */
function kinds(text: string, jurisdiction: Jurisdiction = "cn"): WordingIssueKind[] {
  return [...new Set(inspectWording(text, jurisdiction).map(issue => issue.kind))];
}

function flowchart(labels: string[], edgeLabel?: string): FigureSpec {
  return {
    figure_no: 1,
    kind: "flowchart",
    nodes: labels.map((label, i) => ({ id: `n${i}`, label })),
    edges:
      labels.length > 1 ? [{ from: "n0", to: "n1", ...(edgeLabel === undefined ? {} : { label: edgeLabel }) }] : [],
  };
}

test("防误伤：全大写缩写/计量单位/括号注明原文/大写后缀/步骤标号均不报", () => {
  for (const clean of [
    "CPU",
    "I2C 总线",
    "A/D 转换",
    "24V 电源",
    "采样 100ms",
    "3D 打印头",
    "S101",
    "子件20A",
    "式(1)",
    "步骤(1)",
    "图(1)",
    "控制器(controller)",
  ]) {
    assert.deepEqual(kinds(clean), [], `「${clean}」不应在 cn 下报出用语缺陷`);
    assert.deepEqual(kinds(clean, "us"), [], `「${clean}」不应在 us 下报出用语缺陷`);
  }
  // Sati 自己的图面惯用形 `处理模块(20)` 在 cn 合法（CN 法条未禁括号连用），
  // 在 us/pct 属禁止形态（37 CFR 1.84(p)(1) / PCT Rule 11.13(e)）——见下条测试。
  assert.deepEqual(kinds("处理模块(20)"), []);
});

test("V13 图面词语非中文：仅 cn 生效（us 模式的图面词语本应为英文）", () => {
  assert.deepEqual(kinds("Input Sensor"), ["non-chinese-wording"]);
  assert.deepEqual(kinds("controller"), ["non-chinese-wording"]);
  assert.deepEqual(kinds("Input Sensor", "us"), []);
  // 全大写缩写与单位符号放行，中文+缩写混排（USB接口）不报
  assert.deepEqual(kinds("USB 接口"), []);
});

test("V12 非必需注释：注释前缀/正文引用/尺寸标注/句末标点/图号入图", () => {
  assert.ok(kinds("注：此处为优选实施方式").includes("annotation-prefix"));
  assert.ok(kinds("备注：耐压等级更高").includes("annotation-prefix"));
  assert.ok(kinds("如图1所示，两模块相连").includes("body-reference"));
  assert.ok(kinds("参见图2的连接关系").includes("body-reference"));
  assert.ok(kinds("管径 20mm 的管路").includes("dimension-annotation"));
  assert.ok(kinds("间距 3 厘米").includes("dimension-annotation"));
  assert.ok(kinds("该步骤至此完成。").includes("terminal-punctuation"));
  assert.ok(kinds("如图1所示，两模块相连").includes("figure-number-in-drawing"));
  assert.ok(kinds("FIG. 1 的系统结构").includes("figure-number-in-drawing"));
  // 正常图面词语不报
  assert.deepEqual(kinds("反应釜"), []);
  assert.deepEqual(kinds("判断是否超阈值"), []);
});

test("V12 比例标注：仅非 cn 生效（PCT 指南 5.150 / 37 CFR 1.84(k)）", () => {
  assert.deepEqual(kinds("比例 1:2"), []);
  assert.deepEqual(kinds("比例 1:2", "us"), ["scale-annotation"]);
  assert.deepEqual(kinds("缩放 1:5", "us"), ["scale-annotation"]);
  assert.deepEqual(kinds("scale 1/2", "us"), ["scale-annotation"]);
});

test("V14 标号与括号/引号/圈号连用：仅非 cn 生效", () => {
  assert.deepEqual(kinds("处理模块(20)"), []);
  assert.deepEqual(kinds("处理模块(20)", "us"), ["numeral-in-brackets"]);
  assert.deepEqual(kinds("「20」", "us"), ["numeral-in-brackets"]);
  assert.deepEqual(kinds("①", "us"), ["numeral-in-brackets"]);
  // 公式/步骤/图号类编号不是附图标记，排除
  assert.deepEqual(kinds("式(1)", "us"), []);
  assert.deepEqual(kinds("步骤(2)", "us"), []);
});

test("V14 小写字母后缀标号全法域报（大写后缀是 US/PCT 允许的部分视图写法）", () => {
  assert.deepEqual(kinds("子件20a"), ["numeral-with-letter-affix"]);
  assert.deepEqual(kinds("子件20a", "us"), ["numeral-with-letter-affix"]);
});

test("扫描面覆盖边标签，位置注明到节点/边", () => {
  const hits = scanFigureWording([flowchart(["开始", "结束"], "注：分支条件为真")]);
  const edgeHit = hits.find(hit => hit.kind === "annotation-prefix");
  assert.ok(edgeHit, hits.map(h => h.kind).join(","));
  assert.equal(edgeHit.where, "边「n0→n1」");
  assert.equal(edgeHit.rule, "V12");
});

test("checkFigures：V12/V13/V14 以 warn 级 finding 出报告，证据含图号与位置", () => {
  const result = checkFigures([flowchart(["注：这是说明", "Input Sensor", "子件20a"])], "无标记文本", {
    skipTextRules: true,
  });
  for (const rule of ["V12", "V13", "V14"] as const) {
    const finding = result.findings.find(f => f.rule === rule);
    assert.ok(finding, `应报出 ${rule}`);
    assert.equal(finding.severity, "warn");
    assert.ok(finding.evidence && finding.evidence.length > 0, `${rule} 需给证据`);
    assert.match(finding.evidence[0] ?? "", /^图1 节点「n\d」/u);
  }
  assert.equal(result.ok, true, "图面用语规则不阻断定稿（warn 级）");
});

test("checkFigures：us 下 V13 不出现、V14 的括号连用出现", () => {
  const figures = [flowchart(["Input Sensor", "处理模块(20)"])];
  const cn = checkFigures(figures, "", { skipTextRules: true });
  const us = checkFigures(figures, "", { jurisdiction: "us", skipTextRules: true });
  assert.ok(
    cn.findings.some(f => f.rule === "V13"),
    "cn 应报非中文词语",
  );
  assert.ok(
    cn.findings.every(f => f.rule !== "V14"),
    "cn 不应报括号连用",
  );
  assert.ok(
    us.findings.every(f => f.rule !== "V13"),
    "us 不报非中文词语",
  );
  assert.ok(
    us.findings.some(f => f.rule === "V14"),
    "us 应报括号连用",
  );
});

test("checkFigures：同类命中过多时证据截断并注明余量", () => {
  const labels = Array.from({ length: WORDING_EVIDENCE_MAX + 5 }, (_unused, i) => `注：说明${i}`);
  const result = checkFigures([flowchart(labels)], "", { skipTextRules: true });
  const finding = result.findings.find(f => f.rule === "V12");
  assert.ok(finding?.evidence);
  assert.equal(finding.evidence.length, WORDING_EVIDENCE_MAX + 1);
  assert.match(finding.evidence[WORDING_EVIDENCE_MAX] ?? "", /另有 5 处同类命中/u);
});
