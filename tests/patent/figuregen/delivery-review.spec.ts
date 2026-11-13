/**
 * src/patent/figuregen/delivery-review — 交付面复核（DR 族 + 图面用语终检）的行为测试。
 *
 * 移植自 deepseek-harness `packages/patent/patent-tools/tests/delivery-review.spec.ts`
 * （位图/横向/整幅框线/图面用语四项 + 正常图零命中），并补本仓适配的回归护栏：
 * - **整幅白底矩形不判整幅框线**：自产图根下有一个铺满画布的白底矩形（无描边），
 *   照搬 DSH 的"任意闭合子路径"判据会把每一张自产图都判成框线；
 * - **图号标注（图1）不当作图面词语**：图号在附图正下方，是 4.3 要求、V15/V16 判的对象，
 *   把它报成 V12「图面出现图号字样」会与 V15 自相矛盾；
 * - **法域适用性**：V13（非中文词语）只在 cn 命中，与既有 wording 规则同域。
 *
 * 判据与阈值的来源见 `src/patent/figuregen/delivery-review.ts` 的模块头注。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkFigureDelivery } from "../../../src/patent/figuregen/delivery-review.js";

/** 包一张最小 SVG；画布尺寸按用例给出（默认 100mm × 100mm 的正方形）。 */
function svg(body: string, width = "100mm", height = "100mm", viewBox = "0 0 100 100"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>`;
}

/** 取某条规则号的发现（便于断言"只有这条命中"）。 */
function findingsOf(svgText: string, rule: string, jurisdiction?: "cn" | "us" | "pct") {
  return checkFigureDelivery(svgText, jurisdiction === undefined ? {} : { jurisdiction }).filter(
    finding => finding.rule === rule,
  );
}

test("反例一：含 <image> 的图面给出 DR1（位图/照片，fail）", () => {
  const findings = checkFigureDelivery(svg('<image href="photo.png" width="10" height="10"/>'));
  const dr1 = findings.filter(finding => finding.rule === "DR1");
  assert.equal(dr1.length, 1, `应恰好一条 DR1，实际 ${JSON.stringify(findings)}`);
  assert.equal(dr1[0]?.kind, "figure-photo");
  assert.equal(dr1[0]?.severity, "fail");
  assert.match(dr1[0]?.message ?? "", /照片/u);
  assert.match(dr1[0]?.message ?? "", /《专利审查指南》第一部分第一章 4\.3/u, "消息须带依据出处");
  assert.ok(
    dr1[0]?.evidence?.some(line => line.includes("<image>")),
    `证据行须指出命中元素：${JSON.stringify(dr1[0]?.evidence)}`,
  );
});

test("反例二：横向画布（200×100mm，宽于竖向版心）给出 DR2（横向摆放，fail）", () => {
  const findings = checkFigureDelivery(
    svg('<rect x="10" y="10" width="20" height="20" stroke="#000000"/>', "200mm", "100mm", "0 0 200 100"),
  );
  const dr2 = findings.filter(finding => finding.rule === "DR2");
  assert.equal(dr2.length, 1, `应恰好一条 DR2，实际 ${JSON.stringify(findings)}`);
  assert.equal(dr2[0]?.kind, "figure-orientation");
  assert.equal(dr2[0]?.severity, "fail");
  assert.match(dr2[0]?.message ?? "", /横向/u);
  assert.match(dr2[0]?.message ?? "", /竖向/u);
  assert.match(dr2[0]?.message ?? "", /4\.3/u, "消息须带依据出处");
  assert.match(dr2[0]?.message ?? "", /200×100 毫米/u, "消息须给出实测画幅");
});

test("DR2 的版心前置条件：宽高比虽大于阈值但竖向页放得下 ⇒ 不判（自产图的实际比例）", () => {
  // 自产图实测：单节点流程图 45.5×37.3mm（宽/高 1.22）、LR 块图 118.5×37.3mm（宽/高 3.18）。
  // 这两类图放在竖向附图页上放得下，不是交付缺陷——照搬 DSH 的"只看宽高比"会把它们全判成横向。
  const singleNode = checkFigureDelivery(
    svg('<rect x="10" y="10" width="20" height="20" stroke="#000000"/>', "45.5mm", "37.3mm", "0 0 45.5 37.3"),
  );
  assert.equal(singleNode.filter(finding => finding.rule === "DR2").length, 0, "方图不该判横向");
  const wideBlock = checkFigureDelivery(
    svg('<rect x="10" y="10" width="20" height="20" stroke="#000000"/>', "118.5mm", "37.3mm", "0 0 118.5 37.3"),
  );
  assert.equal(wideBlock.filter(finding => finding.rule === "DR2").length, 0, "横向块图不该判横向");
});

test("反例三：覆盖整幅的描边矩形给出 DR3（整幅框线，fail）", () => {
  const findings = checkFigureDelivery(svg('<rect x="5" y="5" width="90" height="90" fill="none" stroke="#000000"/>'));
  const dr3 = findings.filter(finding => finding.rule === "DR3");
  assert.equal(dr3.length, 1, `应恰好一条 DR3，实际 ${JSON.stringify(findings)}`);
  assert.equal(dr3[0]?.kind, "figure-frame");
  assert.equal(dr3[0]?.severity, "fail");
  assert.match(dr3[0]?.message ?? "", /框线/u);
  assert.match(dr3[0]?.message ?? "", /不得有与图无关的框线/u, "消息须带 4.3 原文");
  assert.ok(
    dr3[0]?.evidence?.some(line => line.includes("包围盒")),
    `证据行须给出实测包围盒：${JSON.stringify(dr3[0]?.evidence)}`,
  );
});

test("反例四：图面英文词语在 cn 下命中 V13（非中文词语，warn）", () => {
  const findings = checkFigureDelivery(svg('<text x="10" y="20" font-size="3">Controller</text>'));
  const v13 = findings.filter(finding => finding.rule === "V13");
  assert.equal(v13.length, 1, `应恰好一条 V13，实际 ${JSON.stringify(findings)}`);
  assert.equal(v13[0]?.severity, "warn", "用语发现的级别沿用 WORDING_KIND_SPEC（warn）");
  assert.match(v13[0]?.message ?? "", /指南一部一章 4\.3/u, "消息须带依据出处");
  assert.ok(
    v13[0]?.evidence?.some(line => line.includes("图面文字「Controller」")),
    `证据行须指出图面文字：${JSON.stringify(v13[0]?.evidence)}`,
  );
});

test("用语发现按命中逐条报（一处命中一条发现，证据行带命中片段）", () => {
  // inspectWording 按拉丁词元逐个报非中文词语 ⇒ "Input Sensor" 出两条 V13。
  const findings = checkFigureDelivery(svg('<text x="10" y="20" font-size="3">Input Sensor</text>'));
  const v13 = findings.filter(finding => finding.rule === "V13");
  assert.equal(v13.length, 2, `两个非中文词元应各报一条，实际 ${JSON.stringify(findings)}`);
  const hits = v13.flatMap(finding => finding.evidence ?? []).filter(line => line.startsWith("命中："));
  assert.deepEqual(hits.sort(), ["命中：「Input」", "命中：「Sensor」"]);
});

test("正常图零命中：竖向、无位图、无整幅框线、中文标号", () => {
  const findings = checkFigureDelivery(
    svg(
      '<rect x="20" y="20" width="60" height="40" fill="none" stroke="#000000"/>' +
        '<text x="50" y="45" font-size="3">处理模块</text>' +
        '<text x="50" y="90" font-size="3">图1</text>',
    ),
  );
  assert.deepEqual(findings, [], `正常图不应有发现，实际 ${JSON.stringify(findings)}`);
});

test("整幅白底矩形（自产图的背景）不判整幅框线", () => {
  // 自产图根下有一个铺满画布的白底矩形（`render-svg.ts` 的 documentSvg，fill 无描边）：
  // 它不是"画出来的线"，判成框线会把每一张自产图都误报。
  const findings = checkFigureDelivery(svg('<rect x="0" y="0" width="100" height="100" fill="#FFFFFF"/>'));
  assert.deepEqual(findings, [], `白底矩形不应触发 DR3，实际 ${JSON.stringify(findings)}`);
});

test("图号标注（图1）不当作图面词语（与 V15 的编号义务不自相矛盾）", () => {
  const findings = checkFigureDelivery(svg('<text x="50" y="90" font-size="3">图1</text>'));
  assert.deepEqual(findings, [], `图号标注不应触发 V12，实际 ${JSON.stringify(findings)}`);
});

test("法域适用性：非 cn 法域不判 V13（非中文词语仅 cn）", () => {
  const svgText = svg('<text x="10" y="20" font-size="3">Controller</text>');
  assert.equal(findingsOf(svgText, "V13", "cn").length, 1, "cn 下应判 V13");
  assert.equal(findingsOf(svgText, "V13", "us").length, 0, "us 下不判 V13");
  assert.equal(findingsOf(svgText, "V13", "pct").length, 0, "pct 下不判 V13");
});

test("画布尺寸未声明时跳过方向与框线判据（不拿用户单位冒充纸面毫米）", () => {
  const findings = checkFigureDelivery(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="9" height="9" stroke="#000000"/></svg>',
  );
  assert.deepEqual(findings, [], `尺寸缺失时不应判横向/框线，实际 ${JSON.stringify(findings)}`);
});

test("方形与近方形不算横向（阈值 1.05）", () => {
  const square = checkFigureDelivery(svg('<rect x="10" y="10" width="10" height="10" stroke="#000000"/>'));
  assert.equal(square.filter(finding => finding.rule === "DR2").length, 0, "正方形不算横向");
  const nearSquare = checkFigureDelivery(
    svg('<rect x="10" y="10" width="10" height="10" stroke="#000000"/>', "104mm", "100mm", "0 0 104 100"),
  );
  assert.equal(nearSquare.filter(finding => finding.rule === "DR2").length, 0, "近方形不算横向");
});
