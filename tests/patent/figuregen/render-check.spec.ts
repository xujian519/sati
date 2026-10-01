/**
 * tests/patent/figuregen/render-check — 矢量源渲染复核的用例。
 *
 * 五类「只在渲染结果上才看得见的缺陷」各配真阳性与阴性对照；未量测结构逐类验证；纯函数
 * （文字占位框、视口换算）单独验证。所有阈值都是**实测口径**：用例里的坐标按源实现的
 * 判定条件构造（用户单位 → 毫米按 25.4/96），不是按直觉写死的期望值。
 *
 * 两条需要留意的口径：
 * 1. 点划线主用例用**显式线段**铺出点划样式，与 `stroke-dasharray` 解析解耦（便于独立
 *    验证"间隔被实线填满"这一判据）；dasharray 自身的单位换算另有专门用例钉住
 *    「按用户单位取值 → 乘一次累计缩放得毫米」。
 * 2. 剖面线的两个**等大**且相邻的闭合框会被判成镜像对而不比较，用例因此用不等尺寸的框。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  boxQuad,
  boxCrossedBySegment,
  glyphBox,
  inflateQuad,
  leaderEnd,
  quadCrossedBySegment,
  textWidthMm,
  FULL_WIDTH_RATIO,
  GLYPH_ASCENT_RATIO,
  GLYPH_DESCENT_RATIO,
  GLYPH_WIDTH_RATIO,
  UPPER_WIDTH_RATIO,
} from "../../../src/patent/figuregen/glyph-box.js";
import { MM_PER_USER_UNIT, parseLengthMm, resolveSvgViewport } from "../../../src/patent/figuregen/svg-viewport.js";
import { SvgSafetyError } from "../../../src/patent/figuregen/svg-safety.js";
import {
  checkFigureRendering,
  measureInkBounds,
  type RenderCheckKind,
  type RenderCheckReport,
} from "../../../src/patent/figuregen/render-check.js";

/** 包一层根元素；缺省 200×200 用户单位，足以放下各用例的构造图元。 */
function svg(body: string, attrs = 'width="200" height="200"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

/** 找出报告里的问题类别（按出现顺序）。 */
function kinds(input: string): RenderCheckKind[] {
  return checkFigureRendering(input).findings.map(finding => finding.check);
}

/** 取某一类问题的报告措辞。 */
function messagesOf(input: string, kind: RenderCheckKind): string[] {
  return checkFigureRendering(input)
    .findings.filter(finding => finding.check === kind)
    .map(finding => finding.message);
}

/** 断言报告里恰好出现这几类问题（顺序敏感，多余一类即红）。 */
function assertKinds(input: string, expected: readonly RenderCheckKind[]): void {
  assert.deepEqual(kinds(input), expected, `用例：${input}`);
}

/** 断言某一类缺陷**没有**被报出（阴性对照的判据）。 */
function assertNoKind(input: string, kind: RenderCheckKind): void {
  assert.ok(!kinds(input).includes(kind), `不应报 ${kind}：${input}`);
}

// ── 文字贯穿与净距 ────────────────────────────────────────────────────────────

/**
 * 「A」在 x=100/y=50/字号 4 下的占位框（实测）：x 100–103、y 47–50.48 用户单位。
 * 贯穿判据要求线段**进入框内**至少 GLYPH_BOX_TOLERANCE_MM，净距判据把框外扩 1.5 毫米
 * （毫米口径，1.5 毫米 ≈ 5.67 用户单位）后再用同一判据。
 */
const TEXT_AT_100_50 = '<text x="100" y="50" font-size="4">A</text>';

test("文字被线条贯穿：线段进入占位框内部时报 text-crossed-by-line", () => {
  const input = svg(`${TEXT_AT_100_50}<line x1="98" y1="48" x2="106" y2="48"/>`);
  assertKinds(input, ["text-crossed-by-line"]);
  assert.match(messagesOf(input, "text-crossed-by-line")[0] ?? "", /「A」被线条贯穿/);
});

test("文字被线条贯穿：线段落在占位框外（含净距）时不报", () => {
  // y=41 距占位框上沿（47）6 用户单位 ≈ 1.59 毫米 > 1.5 毫米净距。
  const input = svg(`${TEXT_AT_100_50}<line x1="98" y1="41" x2="106" y2="41"/>`);
  assert.deepEqual(kinds(input), []);
});

test("文字与图线净距不足：外扩净距后仍相交时报 text-clearance 并给出实测距离", () => {
  // y=44 距占位框上沿 3 用户单位 ≈ 0.79 毫米 < 1.5 毫米。
  const input = svg(`${TEXT_AT_100_50}<line x1="98" y1="44" x2="106" y2="44"/>`);
  assertKinds(input, ["text-clearance"]);
  assert.match(messagesOf(input, "text-clearance")[0] ?? "", /不足 1\.5 毫米净距/);
});

test("文字与图线净距不足：textClearanceMm 传 0 关闭该判据", () => {
  const input = svg(`${TEXT_AT_100_50}<line x1="98" y1="44" x2="106" y2="44"/>`);
  const report = checkFigureRendering(input, { textClearanceMm: 0 });
  assert.deepEqual(
    report.findings.map(finding => finding.check),
    [],
  );
});

test("文字与图线净距不足：引线（data-dsh-role=leader）不参与净距判定", () => {
  // 同一条线，标成引线后不报净距：引线本来就止于文字外框。
  const plain = svg(`${TEXT_AT_100_50}<line x1="98" y1="44" x2="106" y2="44"/>`);
  const leader = svg(`${TEXT_AT_100_50}<line x1="98" y1="44" x2="106" y2="44" data-dsh-role="leader"/>`);
  assertKinds(plain, ["text-clearance"]);
  assert.deepEqual(kinds(leader), []);
});

// ── 点划线被实线覆盖 ──────────────────────────────────────────────────────────

/** 毫米 → 用户单位：用例按毫米铺点划样式，与坐标口径解耦。 */
function userUnits(mm: number): number {
  return mm / MM_PER_USER_UNIT;
}

/**
 * 显式铺出点划线：长划 8 毫米、间隔 2 毫米、点 0.4 毫米、间隔 2 毫米，四轮共 49.6 毫米。
 * 用显式线段而不是 `stroke-dasharray`：源实现把 dasharray 又按元素缩放量了一次，两者
 * 不是同一口径（dasharray 的当前口径由下面那条用例单独钉住）。
 */
function dashDotLine(y = 130): { readonly body: string; readonly spanMm: number } {
  const marks = [8, 2, 0.4, 2];
  const body: string[] = [];
  let cursor = 0;
  for (let index = 0; index < 16; index += 1) {
    const length = marks[index % marks.length] as number;
    if (index % 2 === 0) {
      body.push(`<line x1="${userUnits(cursor)}" y1="${y}" x2="${userUnits(cursor + length)}" y2="${y}"/>`);
    }
    cursor += length;
  }
  return { body: body.join(""), spanMm: cursor };
}

test("点划线被实线覆盖：同一行既有长划+点又有整段实线时报 centerline-covered", () => {
  const { body, spanMm } = dashDotLine();
  const input = svg(`${body}<line x1="0" y1="130" x2="${userUnits(spanMm)}" y2="130"/>`);
  assertKinds(input, ["centerline-covered"]);
  assert.match(messagesOf(input, "centerline-covered")[0] ?? "", /点划线被同位置的实线覆盖/);
});

test("点划线被实线覆盖：只有点划线、间隔可见时不报", () => {
  const { body } = dashDotLine();
  assert.deepEqual(kinds(svg(body)), []);
});

test("点划线被实线覆盖：另一条点划线叠在点划线上不算实线覆盖", () => {
  const { body } = dashDotLine();
  assert.deepEqual(kinds(svg(body + body)), []);
});

test("点划线被实线覆盖：span 不足的点划样式（零碎短边）不报", () => {
  // 只有一轮点划（12.4 毫米 < DASH_DOT_MIN_SPAN_MM 的 20 毫米），加实线也不判。
  const marks = [8, 2, 0.4, 2];
  const body: string[] = [];
  let cursor = 0;
  for (let index = 0; index < 4; index += 1) {
    const length = marks[index % marks.length] as number;
    if (index % 2 === 0) {
      body.push(`<line x1="${userUnits(cursor)}" y1="130" x2="${userUnits(cursor + length)}" y2="130"/>`);
    }
    cursor += length;
  }
  const input = svg(`${body.join("")}<line x1="0" y1="130" x2="${userUnits(cursor)}" y2="130"/>`);
  assert.deepEqual(kinds(input), []);
});

test("stroke-dasharray 按用户单位取值 → 乘一次累计缩放得毫米（同一段长在两种单位文档里得不同毫米数）", () => {
  // SVG 规范：`stroke-dasharray` 的数值是**用户单位**（与 x/y 同域）。量测把它乘上该元素
  // 的累计缩放（用户单位 → 毫米）才是打印毫米数——本模块只乘这一次，量测范围注释里
  // 写的就是「按元素累计缩放又乘了一次」，指的是这一步。
  //
  // 下面两组的属性值**完全相同**（"8 2 0.4 2"），只有根元素声明的单位不同：
  // - 无单位（= CSS px，1px = 25.4/96 ≈ 0.2646mm）⇒ 长划 8 × 0.2646 ≈ 2.12mm，
  //   够不上 DASH_MIN_LENGTH_MM(3)，`dashes` 计数为 0 ⇒ 同位置叠实线也不判覆盖；
  // - `width="200mm" viewBox="0 0 200 200"` ⇒ 1 用户单位 = 1mm，长划 8mm 达标 ⇒ 判覆盖。
  // 两组的差异正是换算链生效的证据，而不是"单位换算错了"。
  // 与本仓产物的对应：`render-svg.ts` 的根元素是**无单位 px** 口径（其虚线边
  // `stroke-dasharray="6 4"` 的长划为 1.59mm），`cad/render-cad.ts` 是 mm 口径
  // （隐藏线 1.5mm）——两者都不是点划线的长划，故 `centerline-covered` 在本仓
  // 内置产物上本就无对象，它服务的是外部/第三方图纸。
  const dasharray = 'stroke-dasharray="8 2 0.4 2"';
  const dashed = `<line x1="0" y1="130" x2="187.5" y2="130" ${dasharray}/>`;
  const solid = '<line x1="0" y1="130" x2="187.5" y2="130"/>';

  assert.deepEqual(kinds(svg(`${dashed}${solid}`)), [], "px 文档：长划 2.12mm < 3mm，正确不报");
  assertKinds(svg(`${dashed}${solid}`, 'width="200mm" height="200mm" viewBox="0 0 200 200"'), ["centerline-covered"]);
});

// ── 相邻零件剖面线难以区分 ────────────────────────────────────────────────────

/**
 * 两个相邻矩形（20×20 与 20×12，间隙 0）＋剖面线。
 * 注意：两个**等大**的相邻矩形会被 isMirrorPair 判成镜像对而不比较，故这里尺寸不同。
 * 剖面线取向差与间距比都要分不清才报（GB/T 4457.5 的两项有一项可区分即不报）。
 */
const HATCH_FRAMES = '<polygon points="0,0 20,0 20,20 0,20"/><polygon points="20,0 40,0 40,12 20,12"/>';
const HATCH_A_45 = [
  '<line x1="0" y1="12" x2="8" y2="20"/>',
  '<line x1="0" y1="8" x2="12" y2="20"/>',
  '<line x1="0" y1="4" x2="16" y2="20"/>',
  '<line x1="0" y1="0" x2="20" y2="20"/>',
].join("");
/** 同取向（45°）且间距相近的剖面线。 */
const HATCH_B_45 = [
  '<line x1="20" y1="10" x2="22" y2="12"/>',
  '<line x1="20" y1="4" x2="28" y2="12"/>',
  '<line x1="20" y1="0" x2="32" y2="12"/>',
].join("");
/** 方向相反的剖面线（135°）。 */
const HATCH_B_135 = [
  '<line x1="20" y1="20" x2="28" y2="12"/>',
  '<line x1="20" y1="16" x2="32" y2="12"/>',
  '<line x1="20" y1="12" x2="36" y2="12"/>',
].join("");

test("相邻零件剖面线难以区分：方向差与间距比都分不清时报 hatch-orientation-collision", () => {
  const input = svg(`${HATCH_FRAMES}${HATCH_A_45}${HATCH_B_45}`);
  assertKinds(input, ["hatch-orientation-collision"]);
  assert.match(messagesOf(input, "hatch-orientation-collision")[0] ?? "", /剖面线方向仅差/);
});

test("相邻零件剖面线难以区分：方向相反（135° vs 45°）时不报", () => {
  const input = svg(`${HATCH_FRAMES}${HATCH_A_45}${HATCH_B_135}`);
  assertNoKind(input, "hatch-orientation-collision");
});

test("相邻零件剖面线难以区分：只有一件带剖面线时不报", () => {
  const input = svg(`${HATCH_FRAMES}${HATCH_A_45}`);
  assertNoKind(input, "hatch-orientation-collision");
});

test("相邻零件剖面线难以区分：两轮廓带同一 data-dsh-hatch-group 时不比较", () => {
  // 同一材料的几段轮廓各给一段是输入约定，不按相邻两件比较。
  const frames =
    '<polygon points="0,0 20,0 20,20 0,20" data-dsh-hatch-group="7"/>' +
    '<polygon points="20,0 40,0 40,12 20,12" data-dsh-hatch-group="7"/>';
  const input = svg(`${frames}${HATCH_A_45}${HATCH_B_45}`);
  assertNoKind(input, "hatch-orientation-collision");
});

test("相邻零件剖面线难以区分：等大的相邻矩形按镜像对处理，不报", () => {
  // 源实现的既定口径：两个等大、并排相接的矩形被视为同一零件的一对镜像轮廓。
  const frames = '<polygon points="0,0 20,0 20,20 0,20"/><polygon points="20,0 40,0 40,20 20,20"/>';
  const input = svg(`${frames}${HATCH_A_45}${HATCH_B_45}`);
  assertNoKind(input, "hatch-orientation-collision");
});

// ── 内容越出画布 ──────────────────────────────────────────────────────────────

test("内容越出画布：线段伸到声明的画布之外时报 ink-outside-canvas", () => {
  const input = svg('<line x1="0" y1="50" x2="250" y2="50"/>');
  assertKinds(input, ["ink-outside-canvas"]);
  assert.match(messagesOf(input, "ink-outside-canvas")[0] ?? "", /越出画布/);
});

test("内容越出画布：墨迹落在画布内时不报", () => {
  assert.deepEqual(kinds(svg('<line x1="0" y1="50" x2="199" y2="50"/>')), []);
});

test("内容越出画布：根元素未声明画布尺寸时不判定", () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg"><line x1="-500" y1="-500" x2="900" y2="900"/></svg>';
  const report = checkFigureRendering(input);
  assert.equal(report.widthMm, undefined);
  assert.equal(report.heightMm, undefined);
  assertNoKind(input, "ink-outside-canvas");
});

// ── 未量测结构 ────────────────────────────────────────────────────────────────

test("not-measured：<style> 的 CSS 类规则记一条未量测", () => {
  const input = svg('<style>.a{stroke:#000}</style><line class="a" x1="0" y1="50" x2="90" y2="50"/>');
  assertKinds(input, ["not-measured"]);
  assert.match(messagesOf(input, "not-measured")[0] ?? "", /<style>/);
});

test("not-measured：<use>/<image> 引用记一条未量测", () => {
  const use =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<defs><line id="l" x1="0" y1="50" x2="90" y2="50"/></defs><use href="#l"/></svg>';
  const image =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<image href="a.png" x="0" y="0" width="10" height="10"/></svg>';
  assert.match(messagesOf(use, "not-measured")[0] ?? "", /<use>/);
  assert.match(messagesOf(image, "not-measured")[0] ?? "", /<image>/);
});

test("not-measured：<tspan> 的 x/y/dx/dy 位移记一条未量测", () => {
  const input = svg('<text x="25" y="25" font-size="1"><tspan dx="5">A</tspan></text>');
  assertKinds(input, ["not-measured"]);
  assert.match(messagesOf(input, "not-measured")[0] ?? "", /<tspan>/);
});

test("not-measured：没有未量测结构时不插占位（阴性对照）", () => {
  // 同一条文字，去掉 tspan 位移后量得到、且不插 not-measured。
  const input = svg('<text x="25" y="25" font-size="1">A</text>');
  assert.deepEqual(kinds(input), []);
});

test("not-measured：端头标记、百分比长度与曲线命令各记一条未量测", () => {
  const marker = svg('<line x1="0" y1="50" x2="90" y2="50" marker-end="url(#m)"/>');
  const percent = svg('<line x1="0" y1="50" x2="50%" y2="50"/>');
  const curve = svg('<path d="M0,50 C10,10 20,90 30,50"/>');
  assert.match(messagesOf(marker, "not-measured")[0] ?? "", /marker-start\/mid\/end/);
  assert.match(messagesOf(percent, "not-measured")[0] ?? "", /百分比/);
  assert.match(messagesOf(curve, "not-measured")[0] ?? "", /曲线/);
});

test("not-measured：同一原因只记一条（去重）", () => {
  const input = svg('<line x1="0" y1="50" x2="50%" y2="50"/><line x1="0" y1="60" x2="50%" y2="60"/>');
  const notMeasured = messagesOf(input, "not-measured");
  assert.equal(notMeasured.length, 1);
  assert.equal((notMeasured[0] ?? "").match(/百分比/g)?.length, 1);
});

test("not-measured：不量化结构时报告为空，报告里没有 not-measured 才等于逐类量测过", () => {
  // 契约钉子：几何完全量得到的图不插 not-measured；一旦有未量测结构就必然出现该类别。
  assert.deepEqual(kinds(svg('<line x1="0" y1="50" x2="90" y2="50"/>')), []);
  assert.ok(kinds(svg('<path d="M0,50 C10,10 20,90 30,50"/>')).includes("not-measured"));
});

// ── 报告量测值与输入安全 ──────────────────────────────────────────────────────

test("报告：给出画布尺寸、文字数、线宽分布与取向分布", () => {
  const input = svg(
    `<text x="100" y="50" font-size="4">A</text>` +
      '<line x1="0" y1="50" x2="90" y2="50" stroke="#000" stroke-width="0.5"/>' +
      '<line x1="0" y1="60" x2="90" y2="60" stroke="#000" stroke-width="0.5"/>' +
      '<line x1="0" y1="70" x2="0" y2="150" stroke="#000" stroke-width="0.25"/>',
  );
  const report: RenderCheckReport = checkFigureRendering(input);
  assert.equal(report.textCount, 1);
  assert.equal(report.widthMm, 200 * MM_PER_USER_UNIT);
  assert.equal(report.heightMm, 200 * MM_PER_USER_UNIT);
  // 线宽按元素累计缩放换算到毫米：0.5 与 0.25 用户单位 → 0.132 与 0.066 毫米（三位小数）。
  assert.deepEqual(report.strokeWidthMm, [
    { widthMm: 0.066, count: 1 },
    { widthMm: 0.132, count: 2 },
  ]);
  assert.equal(report.orientationDeg[0]?.orientationDeg, 0);
  assert.equal(report.orientationDeg[0]?.count, 2);
  assert.equal(report.orientationDeg[1]?.orientationDeg, 90);
});

test("报告：未声明 stroke 的图元不进线宽分布（源实现口径，显式 stroke 才计入）", () => {
  const implicit = svg('<line x1="0" y1="50" x2="90" y2="50" stroke-width="0.5"/>');
  const explicit = svg('<line x1="0" y1="50" x2="90" y2="50" stroke="#000" stroke-width="0.5"/>');
  assert.deepEqual(checkFigureRendering(implicit).strokeWidthMm, []);
  assert.deepEqual(checkFigureRendering(explicit).strokeWidthMm, [{ widthMm: 0.132, count: 1 }]);
});

test("报告：stroke: none 的填充图元不计入线宽分布", () => {
  const input = svg('<polygon points="0,0 10,0 10,10" fill="#000" stroke="none"/>');
  assert.deepEqual(checkFigureRendering(input).strokeWidthMm, []);
});

test("报告：输入未过安全门时抛出 SvgSafetyError", () => {
  assert.throws(() => checkFigureRendering("<svg><![CDATA[x]]></svg>"), SvgSafetyError);
  assert.throws(
    () => checkFigureRendering("<svg></svg>", { maxBytes: 4 }),
    (error: unknown) => error instanceof SvgSafetyError && error.code === "too_large",
  );
});

// ── 墨迹包围盒 ────────────────────────────────────────────────────────────────

test("measureInkBounds：线段端点与文字占位框四角的并集", () => {
  const input = svg(
    '<line x1="10" y1="10" x2="90" y2="10"/>' + '<text x="50" y="50" font-size="4" text-anchor="middle">AB</text>',
  );
  const ink = measureInkBounds(input);
  assert.ok(ink !== undefined);
  // 线：y=10 用户单位 → 2.6458 毫米；文字框底 = 50 + 4×0.12 = 50.48 用户单位。
  assert.equal(ink.minX, 10 * MM_PER_USER_UNIT);
  assert.equal(ink.minY, 10 * MM_PER_USER_UNIT);
  assert.equal(ink.maxX, 90 * MM_PER_USER_UNIT);
  assert.equal(ink.maxY, (50 + 4 * GLYPH_DESCENT_RATIO) * MM_PER_USER_UNIT);
});

test("measureInkBounds：没有可量测图元时返回 undefined", () => {
  assert.equal(measureInkBounds(svg("")), undefined);
});

test("measureInkBounds：同样过安全门（非法输入抛错）", () => {
  assert.throws(() => measureInkBounds("<svg><!DOCTYPE svg></svg>"), SvgSafetyError);
});

// ── glyph-box 纯函数 ──────────────────────────────────────────────────────────

test("textWidthMm：宽度随字号线性增长", () => {
  const one = textWidthMm("AB", 1);
  assert.equal(textWidthMm("AB", 2), one * 2);
  assert.equal(textWidthMm("AB", 3.5), one * 3.5);
});

test("textWidthMm：按码点分类累加（小写/数字 0.6、大写 0.75、全角 1）", () => {
  assert.equal(textWidthMm("a1", 10), 2 * GLYPH_WIDTH_RATIO * 10);
  assert.equal(textWidthMm("AB", 10), 2 * UPPER_WIDTH_RATIO * 10);
  assert.equal(textWidthMm("电容", 10), 2 * FULL_WIDTH_RATIO * 10);
  assert.equal(textWidthMm("A电b", 10), (UPPER_WIDTH_RATIO + FULL_WIDTH_RATIO + GLYPH_WIDTH_RATIO) * 10);
  assert.equal(textWidthMm("A电b", 10), textWidthMm("A电b", 5) * 2);
});

test("glyphBox：基线锚点决定上下边，anchor 决定水平位置", () => {
  const start = glyphBox("A", [100, 50], 4, "start");
  assert.deepEqual(start, {
    minX: 100,
    maxX: 100 + 4 * UPPER_WIDTH_RATIO,
    minY: 50 - 4 * GLYPH_ASCENT_RATIO,
    maxY: 50 + 4 * GLYPH_DESCENT_RATIO,
  });
  const middle = glyphBox("A", [100, 50], 4, "middle");
  assert.equal(middle.minX, 100 - (4 * UPPER_WIDTH_RATIO) / 2);
  assert.equal(middle.maxX, 100 + (4 * UPPER_WIDTH_RATIO) / 2);
  const end = glyphBox("A", [100, 50], 4, "end");
  assert.equal(end.minX, 100 - 4 * UPPER_WIDTH_RATIO);
  assert.equal(end.maxX, 100);
});

test("boxCrossedBySegment：线段穿过框内为真，贴边/擦角/框外为假", () => {
  const box = { minX: 100, minY: 47, maxX: 103, maxY: 50.48 };
  const through: readonly [number, number][] = [
    [98, 48.7],
    [106, 48.7],
  ];
  assert.equal(boxCrossedBySegment(box, through[0], through[1]), true);
  // 竖直线穿过框中部
  assert.equal(boxCrossedBySegment(box, [101.5, 40], [101.5, 60]), true);
  // 贴着下沿（框内 0.01 容差以内）不算穿过
  assert.equal(boxCrossedBySegment(box, [98, 50.483], [106, 50.483]), false);
  // 只在角上掠过
  assert.equal(boxCrossedBySegment(box, [97, 47.3], [99, 46]), false);
  // 完全在框外
  assert.equal(boxCrossedBySegment(box, [98, 56], [106, 56]), false);
  // 沿边共线
  assert.equal(boxCrossedBySegment(box, [98, 47], [106, 47]), false);
  // 退化框（零宽）没有内部
  assert.equal(boxCrossedBySegment({ minX: 100, minY: 47, maxX: 100, maxY: 50 }, [98, 48], [106, 48]), false);
});

test("quadCrossedBySegment：boxQuad 与轴对齐判定同解（角上掠过也不穿过）", () => {
  const box = { minX: 100, minY: 47, maxX: 103, maxY: 50.48 };
  const quad = boxQuad(box);
  assert.equal(quadCrossedBySegment(quad, [98, 48.7], [106, 48.7]), true);
  assert.equal(quadCrossedBySegment(quad, [97, 47.3], [99, 46]), false);
  assert.equal(quadCrossedBySegment(quad, [98, 56], [106, 56]), false);
});

test("inflateQuad：四周各外扩净距，外扩后原判定随之放宽", () => {
  const box = { minX: 100, minY: 47, maxX: 103, maxY: 50.48 };
  const inflated = inflateQuad(boxQuad(box), 1);
  assert.equal(inflated.origin[0], 99);
  assert.equal(inflated.origin[1], 46);
  assert.equal(inflated.edgeWidth[0], 5);
  assert.ok(Math.abs(inflated.edgeHeight[1] - 5.48) < 1e-12, `实际 ${inflated.edgeHeight[1]}`);
  // 距上沿 0.5 的线：原框不穿过，外扩 1 毫米后穿过。
  const near: readonly [number, number][] = [
    [98, 46.5],
    [106, 46.5],
  ];
  assert.equal(boxCrossedBySegment(box, near[0], near[1]), false);
  assert.equal(quadCrossedBySegment(inflated, near[0], near[1]), true);
});

test("leaderEnd：止点落在占位框边界上，框内/重合起点返回 undefined", () => {
  // 起点与文字框竖向中部同高：止点落在左边中点 (100, 48.74)。
  const end = leaderEnd("A", [100, 50], 4, "start", [0, 48.74]);
  assert.ok(end !== undefined);
  assert.equal(end[0], 100);
  assert.ok(Math.abs(end[1] - 48.74) < 1e-9, `实际 ${end[1]}`);
  // 起点落在占位框内：无止点可取。
  assert.equal(leaderEnd("A", [100, 50], 4, "start", [101.5, 48.74]), undefined);
});

// ── svg-viewport 纯函数 ───────────────────────────────────────────────────────

test("parseLengthMm：px 与无单位按 96 dpi 折算，mm/cm/in/pt 按各自定义", () => {
  assert.equal(parseLengthMm("100"), (100 / 96) * 25.4);
  assert.equal(parseLengthMm("100px"), (100 / 96) * 25.4);
  assert.equal(parseLengthMm("10mm"), 10);
  assert.equal(parseLengthMm("1cm"), 10);
  assert.equal(parseLengthMm("1in"), 25.4);
  assert.equal(parseLengthMm("72pt"), 25.4);
  assert.equal(parseLengthMm(" 2.5 mm "), 2.5);
  assert.equal(parseLengthMm("50%"), undefined);
  assert.equal(parseLengthMm("auto"), undefined);
  assert.equal(parseLengthMm(""), undefined);
});

test("resolveSvgViewport：无 viewBox 时用户单位按 96 dpi 像素，画布尺寸照原样取", () => {
  const viewport = resolveSvgViewport('<svg width="100px" height="50mm">');
  assert.equal(viewport.scaleX, MM_PER_USER_UNIT);
  assert.equal(viewport.scaleY, MM_PER_USER_UNIT);
  assert.equal(viewport.widthMm, (100 / 96) * 25.4);
  assert.equal(viewport.heightMm, 50);
  assert.equal(viewport.viewportWidthMm, (100 / 96) * 25.4);
  assert.equal(viewport.viewportHeightMm, 50);
  assert.equal(viewport.originX, 0);
  assert.equal(viewport.originY, 0);
  assert.equal(viewport.viewBox, undefined);
  assert.equal(viewport.note, undefined);
});

test("resolveSvgViewport：同比例 viewBox 等比缩放，原点对齐 viewBox 原点", () => {
  const viewport = resolveSvgViewport('<svg width="100mm" height="100mm" viewBox="0 0 200 200">');
  assert.equal(viewport.scaleX, 0.5);
  assert.equal(viewport.scaleY, 0.5);
  assert.deepEqual(viewport.viewBox, { x: 0, y: 0, width: 200, height: 200 });
  assert.equal(viewport.originX, 0);
  assert.equal(viewport.originY, 0);
  assert.equal(viewport.note, undefined);
});

test("resolveSvgViewport：缺省 preserveAspectRatio 为 xMidYMid meet（含居中偏移）", () => {
  // 视口 200×100 用户单位装 100×100 的 viewBox：受高度限制等比缩放，X 轴居中偏移，Y 轴不偏移。
  const viewport = resolveSvgViewport('<svg width="200" height="100" viewBox="0 0 100 100">');
  assert.equal(viewport.scaleX, viewport.scaleY);
  assert.equal(viewport.scaleX, ((100 / 96) * 25.4) / 100);
  // 偏移 (viewportWidth - viewBox.width·scale)/2 折算回用户单位后，原点左移。
  const scale = viewport.scaleX;
  const offsetX = ((200 / 96) * 25.4 - 100 * scale) / 2;
  assert.equal(viewport.originX, -offsetX / scale);
  assert.equal(viewport.originY, 0);
  assert.equal(viewport.note, undefined);
});

test("resolveSvgViewport：preserveAspectRatio=xMinYMin meet 时无居中偏移", () => {
  const viewport = resolveSvgViewport(
    '<svg width="150" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet">',
  );
  assert.equal(viewport.originX, 0);
  assert.equal(viewport.originY, 0);
});

test("resolveSvgViewport：preserveAspectRatio=none 两轴各自拉伸并给出 note", () => {
  const viewport = resolveSvgViewport(
    '<svg width="150" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">',
  );
  assert.equal(viewport.scaleX, ((150 / 96) * 25.4) / 100);
  assert.equal(viewport.scaleY, ((100 / 96) * 25.4) / 100);
  assert.notEqual(viewport.scaleX, viewport.scaleY);
  assert.match(viewport.note ?? "", /preserveAspectRatio="none"/);
});

test("resolveSvgViewport：slice 与无法解析的属性各给一条 note", () => {
  const slice = resolveSvgViewport(
    '<svg width="150" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">',
  );
  assert.match(slice.note ?? "", /slice/);
  const invalid = resolveSvgViewport('<svg width="150" height="100" viewBox="0 0 100 100" preserveAspectRatio="随便">');
  assert.match(invalid.note ?? "", /无法解析/);
  const badViewBox = resolveSvgViewport('<svg width="150" height="100" viewBox="0 0 0 100">');
  assert.equal(badViewBox.viewBox, undefined);
  assert.equal(badViewBox.scaleX, MM_PER_USER_UNIT);
  assert.match(badViewBox.note ?? "", /viewBox 无法解析/);
});

test("resolveSvgViewport：只声明一边画布尺寸时给出近似 note", () => {
  const viewport = resolveSvgViewport('<svg width="150" viewBox="0 0 100 100">');
  assert.equal(viewport.widthMm, (150 / 96) * 25.4);
  assert.equal(viewport.heightMm, undefined);
  assert.equal(viewport.viewportHeightMm, MM_PER_USER_UNIT * 100);
  assert.match(viewport.note ?? "", /只声明了一边/);
});

// ── 白色描边挖空（halo）的豁免 ────────────────────────────────────────────────
//
// 本仓内置渲染器把边标签直接放在连线中点上，用 `stroke="#FFFFFF" stroke-width="4"
// paint-order="stroke"` 在字外围形成白圈、把线在字周围视觉断开（render-svg.ts 的标签
// 契约）。几何上线条确实穿过文字框，故若不豁免，本仓**每一张带边标签的图**都会被报成
// 贯穿（实测 flowchart 与 state 图必然命中）。以下三条同时钉住豁免的边界。

test("白色描边挖空的文字不判贯穿；无 paint-order 或描边非白时照常判", () => {
  const solidLine = '<line x1="0" y1="100" x2="200" y2="100"/>';
  const text = (attrs: string) => `<text x="90" y="100" ${attrs}>标签</text>`;

  // 普通文字（无 paint-order）：被线穿过 → 报
  assertKinds(svg(`${solidLine}${text('fill="#000000"')}`), ["text-crossed-by-line"]);

  // 本仓边标签契约：paint-order 先描边 + 白色描边 ⇒ 线在字外围被白边断开 → 豁免
  assert.deepEqual(
    kinds(svg(`${solidLine}${text('fill="#000000" stroke="#FFFFFF" stroke-width="4" paint-order="stroke"')}`)),
    [],
  );

  // 有 paint-order 但描边非白（彩色）：豁免只认"白色挖空"，此处照常判
  assertKinds(svg(`${solidLine}${text('fill="#000000" stroke="#FF0000" stroke-width="4" paint-order="stroke"')}`), [
    "text-crossed-by-line",
  ]);

  // 有 paint-order 但未声明描边：不构成挖空 → 照常判
  assertKinds(svg(`${solidLine}${text('fill="#000000" paint-order="stroke"')}`), ["text-crossed-by-line"]);
});

test("本仓内置渲染器的产物不触发 text-crossed-by-line（边标签 halo 豁免的回归钉）", async () => {
  const { renderFigureSvg } = await import("../../../src/patent/figuregen/render-svg.js");
  // 带边标签的流程图与状态图：边标签落在连线中点上，实测是 halo 豁免的核心场景
  const flowchart = renderFigureSvg(
    {
      figure_no: 1,
      kind: "flowchart",
      nodes: [
        { id: "a", label: "开始", shape: "ellipse" },
        { id: "b", label: "处理模块(20)", ref: 20 },
        { id: "c", label: "结束", shape: "ellipse" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c", label: "是" },
      ],
    },
    { jurisdiction: "cn", figureCount: 1 },
  ).svg;
  assert.deepEqual(kinds(flowchart), ["not-measured"], "仅「未量测」清单，不得报贯穿");

  const state = renderFigureSvg(
    {
      figure_no: 1,
      kind: "state",
      nodes: [
        { id: "s", label: "", shape: "circle" },
        { id: "a", label: "待机", shape: "round" },
        { id: "b", label: "运行", shape: "round" },
        { id: "e", label: "", shape: "doublecircle" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "b", label: "启动" },
        { from: "b", to: "e" },
      ],
    },
    { jurisdiction: "cn", figureCount: 1 },
  ).svg;
  assert.deepEqual(kinds(state), ["not-measured"], "仅「未量测」清单，不得报贯穿");
});
