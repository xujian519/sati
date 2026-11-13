/**
 * src/patent/figuregen/compliance — 附图法域合规核算测试。
 *
 * 本模块的结论会挂到模型面前决定"是否提醒用户改图"，所以测试盯住三件事：
 * ① **触发条件**（图号义务、字高下限、摘要附图缩放各在什么条件下出现/不出现）；
 * ② **口径**（字高下限走档案的 `minCharHeight`——CN 走实践下限且消息必须写明它不是
 * 条文值；PCT/US 走 3.2mm 条文值并引各自条文）；
 * ③ **诚实性**（摘要附图只报缩放后的字高，不宣称"清晰"；纯函数、无隐藏副作用）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  drawingComplianceFindings,
  type ComplianceFinding,
  type ComplianceInput,
} from "../../../src/patent/figuregen/compliance.js";
import { minCharHeight, officeProfile } from "../../../src/patent/figuregen/office-profile.js";
import type { SubmissionPageMetrics } from "../../../src/patent/figuregen/submission-page.js";

/** 落版尺寸（默认值即"全部满足"的合规形态）。 */
function metrics(overrides: Partial<SubmissionPageMetrics> = {}): SubmissionPageMetrics {
  return {
    pageScale: 1,
    drawingWidthMm: 160,
    drawingHeightMm: 220,
    placedWidthMm: 160,
    placedHeightMm: 220,
    charHeightMm: 3.5,
    reducedCharHeightMm: 2.33,
    ...overrides,
  };
}

/** 核算输入（默认走 cnipa 档案，字段可逐项覆盖）。 */
function input(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    profile: officeProfile("cnipa"),
    figureCount: 3,
    hasCaption: true,
    metrics: metrics(),
    ...overrides,
  };
}

/** 取出指定 id 的结论（不存在则 undefined）。 */
function findingOf(findings: readonly ComplianceFinding[], id: string): ComplianceFinding | undefined {
  return findings.find(finding => finding.id === id);
}

test("判据一：附图两幅以上且本幅无图号 → 报图号缺失（按法域给条文出处）", () => {
  const cn = drawingComplianceFindings(input({ hasCaption: false }));
  const cnFinding = findingOf(cn, "figure-number-missing");
  assert.ok(cnFinding, "CN 两幅以上无图号应报缺失");
  assert.equal(cnFinding.severity, "warn");
  assert.ok(cnFinding.message.includes("《专利审查指南》第一部分第一章 4.3"), cnFinding.message);
  assert.ok(cnFinding.message.includes("共 3 幅"), cnFinding.message);

  const pct = drawingComplianceFindings(input({ profile: officeProfile("pct"), hasCaption: false }));
  const pctFinding = findingOf(pct, "figure-number-missing");
  assert.ok(pctFinding, "PCT 两幅以上无图号应报缺失");
  assert.ok(pctFinding.message.includes("PCT 实施细则 11.13(k) 与申请人指南 IP 5.141"), pctFinding.message);

  const us = drawingComplianceFindings(input({ profile: officeProfile("uspto"), hasCaption: false }));
  const usFinding = findingOf(us, "figure-number-missing");
  assert.ok(usFinding, "美国两幅以上无图号应报缺失");
  assert.ok(usFinding.message.includes("37 CFR 1.84(u)"), usFinding.message);
});

test("判据一：单幅（figureCount=1）不报图号缺失——编号义务系于两幅以上", () => {
  const findings = drawingComplianceFindings(input({ figureCount: 1, hasCaption: false }));
  assert.equal(findingOf(findings, "figure-number-missing"), undefined, "单幅不构成图号缺失");
});

test("判据二：字高低于下限 → 报字高不足（pct/uspto 引条文值 3.2mm）", () => {
  const pct = drawingComplianceFindings(
    input({ profile: officeProfile("pct"), metrics: metrics({ charHeightMm: 2.5 }) }),
  );
  const pctFinding = findingOf(pct, "char-height-below-minimum");
  assert.ok(pctFinding, "2.5mm 低于 PCT 的 3.2mm 应报");
  assert.equal(pctFinding.severity, "warn");
  assert.ok(pctFinding.message.includes("2.5 毫米"), pctFinding.message);
  assert.ok(pctFinding.message.includes("3.2 毫米"), pctFinding.message);
  assert.ok(pctFinding.message.includes("性质：条文下限"), pctFinding.message);
  assert.ok(pctFinding.message.includes("PCT 实施细则 11.13(h)"), pctFinding.message);

  const us = drawingComplianceFindings(
    input({ profile: officeProfile("uspto"), metrics: metrics({ charHeightMm: 3.1 }) }),
  );
  const usFinding = findingOf(us, "char-height-below-minimum");
  assert.ok(usFinding, "3.1mm 低于 3.2mm 应报");
  assert.ok(usFinding.message.includes("37 CFR 1.84(p)(3)"), usFinding.message);
});

test("判据二：字高不低于下限 → 不报字高不足", () => {
  const findings = drawingComplianceFindings(
    input({ profile: officeProfile("pct"), metrics: metrics({ charHeightMm: 3.2 }) }),
  );
  assert.equal(findingOf(findings, "char-height-below-minimum"), undefined, "恰好等于下限不算不足");
});

test("判据二：CN 走代理实践下限 2.0mm（basis=practice），消息须写明它不是条文值", () => {
  // 口径前提：CN 档案没有附图字高条文值（minCharHeightMm 为空），下限取自实践值。
  const profile = officeProfile("cnipa");
  assert.equal(profile.minCharHeightMm, undefined, "CN 无附图专有的字高条文值");
  assert.deepEqual(minCharHeight(profile), { mm: 2.0, basis: "practice" });

  const findings = drawingComplianceFindings(input({ metrics: metrics({ charHeightMm: 1.5 }) }));
  const finding = findingOf(findings, "char-height-below-minimum");
  assert.ok(finding, "1.5mm 低于 CN 实践下限 2.0mm 应报");
  assert.ok(finding.message.includes("1.5 毫米"), finding.message);
  assert.ok(finding.message.includes("2 毫米"), finding.message);
  assert.ok(finding.message.includes("性质：实践下限（非法条数值）"), finding.message);
  assert.ok(finding.message.includes("CN 现行指南未设附图字高条文值，此为代理实践下限"), finding.message);
  assert.ok(!finding.message.includes("性质：条文下限"), "CN 的实践下限不得被写成条文下限");
});

test("判据三：摘要附图按 40×60 毫米缩放后报字高，且只报数值不判定清晰", () => {
  // 宽 100 / 高 150 → 缩放比 min(40/100, 60/150) = 0.4 → 4.0mm 字高缩为 1.6mm。
  const findings = drawingComplianceFindings(
    input({
      abstractFigure: true,
      metrics: metrics({ placedWidthMm: 100, placedHeightMm: 150, charHeightMm: 4 }),
    }),
  );
  const finding = findingOf(findings, "abstract-figure-scaled-height");
  assert.ok(finding, "摘要附图应报缩放后字高");
  assert.equal(finding.severity, "warn");
  assert.ok(finding.message.includes("1.6 毫米"), finding.message);
  assert.ok(finding.message.includes("《专利审查指南》第二部分第二章 2.4"), finding.message);
  assert.ok(finding.message.includes("本工具不判定"), finding.message);
  assert.ok(finding.message.includes("清晰与否由人工判断"), finding.message);

  // 宽是瓶颈时取宽的缩放比（高 60 不构成约束）。
  const wide = drawingComplianceFindings(
    input({
      abstractFigure: true,
      metrics: metrics({ placedWidthMm: 200, placedHeightMm: 60, charHeightMm: 3 }),
    }),
  );
  const wideFinding = findingOf(wide, "abstract-figure-scaled-height");
  assert.ok(wideFinding, "摘要附图应报缩放后字高");
  assert.ok(wideFinding.message.includes("0.6 毫米"), wideFinding.message);
});

test("判据三：非摘要附图（或落版尺寸为零）不报摘要缩放结论", () => {
  const notAbstract = drawingComplianceFindings(input({ metrics: metrics({ charHeightMm: 4 }) }));
  assert.equal(findingOf(notAbstract, "abstract-figure-scaled-height"), undefined, "非摘要附图不报");

  const zeroSize = drawingComplianceFindings(
    input({ abstractFigure: true, metrics: metrics({ placedWidthMm: 0, placedHeightMm: 0 }) }),
  );
  assert.equal(findingOf(zeroSize, "abstract-figure-scaled-height"), undefined, "落版尺寸为零无法缩放");
});

test("全部满足时零发现（三条判据都不触发）", () => {
  const findings = drawingComplianceFindings(
    input({ profile: officeProfile("pct"), figureCount: 3, hasCaption: true }),
  );
  assert.deepEqual(findings, [], `不应有任何结论，实际：${JSON.stringify(findings)}`);
});

test("结论可定位且级别恒为 warn（结构化面，便于上层合并去重）", () => {
  const findings = drawingComplianceFindings(
    input({
      profile: officeProfile("cnipa"),
      hasCaption: false,
      abstractFigure: true,
      metrics: metrics({ charHeightMm: 1.2, placedWidthMm: 100, placedHeightMm: 150 }),
    }),
  );
  assert.deepEqual(
    findings.map(finding => finding.id),
    ["figure-number-missing", "char-height-below-minimum", "abstract-figure-scaled-height"],
  );
  for (const finding of findings) {
    assert.equal(finding.severity, "warn", `${finding.id} 的级别应为 warn`);
    assert.ok(finding.message.length > 0, `${finding.id} 缺少结论文本`);
  }
});

test("纯函数：同一输入两次调用结果逐字节相同", () => {
  const args = input({
    profile: officeProfile("uspto"),
    hasCaption: false,
    abstractFigure: true,
    metrics: metrics({ charHeightMm: 2.9, placedWidthMm: 120, placedHeightMm: 90 }),
  });
  assert.deepEqual(drawingComplianceFindings(args), drawingComplianceFindings(args), "结论不应随调用变化");
});
