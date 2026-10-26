/**
 * 附图渲染复核（纯函数，无 IO）：在**已生成的 SVG 源**上量测图面事实，报告只有
 * 看渲染结果才看得见的问题。
 *
 * 为什么量测矢量源而不是位图：矢量源是渲染的唯一输入，线段位置、线宽与字号都在
 * 其中；位图量测要引入栅格化器（rsvg/ImageMagick），而本包的两条渲染通路都不
 * 依赖它们。凡「画出来是什么样」取决于矢量源的地方，本模块都按同一条遍历量测。
 *
 * 覆盖五类只在渲染结果上显现的缺陷（前四类来自实测案例）：
 * - **文字被线条贯穿**：引线或轮廓线穿过文字占位框，标号或元件名读不出（引线的
 *   终点落在文字上、或标号落在被剖面线的零件内都会触发）。
 * - **文字与图线净距不足**：线条没压进字身、但贴着文字占位框（默认不足
 *   {@link DEFAULT_TEXT_CLEARANCE_MM}），标号与元件名周围没有可读的空白。判据把
 *   占位框外扩净距后再用同一「贯穿」判定；引线（绘图侧标注
 *   {@link ROLE_ATTRIBUTE}）与落在不透明填充内的线段不参与——前者本来就止于文字外框，
 *   后者在图面上不可见。
 * - **点划线被实线覆盖**：同一行既有「长划+点」的点划段、又有一整段连续实线，
 *   点划线的间隔在图面上不可见（上下半剖的两半公共边正好落在轴线位置时如此）。
 * - **相邻零件剖面线难以区分**：两件轮廓相邻，剖面线的方向差不超过
 *   {@link ADJACENT_ORIENTATION_LIMIT_DEG} **且**间距比不超过
 *   {@link ADJACENT_SPACING_RATIO_LIMIT}，读成一个零件（GB/T 4457.5 要求相邻零件的
 *   剖面线方向相反或间距不等，两项有一项可区分即不报）。类别标识为
 *   `hatch-orientation-collision`，判据含方向与间距两项。
 * - **内容越出画布**：线段、轮廓或标号落在根元素声明的画布之外，越界部分不会被
 *   渲染出来（后处理放大字号或落版改写画布时最易发生）。
 *
 * 量测范围：根元素的画布尺寸与 `viewBox`/`preserveAspectRatio`（`svg-viewport` 解析成
 * 用户单位 → 毫米的映射，故 px 级用户单位的导出文件与落版页同一口径）；`line`/`polyline`/
 * `polygon`/`rect`/`circle`/`ellipse`/`path`（M/L/H/V/Z，含相对形式）的几何；`text` 的内容、
 * 字号与 `text-anchor`（含自 `<g>` 继承与行内 `style`；未声明字号按 CSS 初值 16 用户单位）；
 * 线段的取向与线宽；`stroke-dasharray` 只用于点划线判定（按虚线段展开）。元素按嵌套逐层
 * 继承 `transform`（translate/scale/rotate/matrix）与线宽/描边/字号，故落版页与拼版页的
 * 缩放、纵排文字都能换算到根坐标系量测。`defs`/`clipPath`/`marker` 等定义容器的子元素与
 * `display: none` 的子树不在图面上渲染，整段跳过。
 *
 * 不在量测范围内的结构各记一条 `not-measured` 发现（同一原因只记一条）：CSS 类样式
 * （`<style>`，含 `<defs>` 内的样式表）、`<use>`/`<image>` 引用、嵌套 `<svg>` 的内层视口、
 * 端头标记（`marker-*`）、`<tspan>` 的 x/y/dx/dy 偏移、`dominant-baseline`/
 * `alignment-baseline`、相对视口的百分比长度、无法解析的 `transform`/路径 `d`/`viewBox`，
 * 以及按端点弦近似的曲线段；视口两轴缩放不等或 `slice` 裁剪时另记一条近似说明。
 * **报告里没有 `not-measured` 时，「未发现问题」才等于逐类量测过。**
 *
 * 输入安全检查复用本仓 svg-safety 的 assertSafeSvg（拒绝实体/CDATA、超限体量与
 * 非 SVG 根元素）；本模块只读文本，不解析实体也不执行内容。
 *
 * 实现按职责拆分：{@link ./render-check-scan} 把 SVG 读成根坐标系下的图面事实，
 * {@link ./render-check-geometry} 提供几何判据所需的线段/包围盒/可见性计算，
 * {@link ./render-check-findings} 承载五类判据；本文件保留公共类型再导出与总装入口。
 * @module src/patent/figuregen/render-check
 */

import { quadCrossedBySegment } from "./glyph-box.js";
import { DEFAULT_SVG_MAX_BYTES, assertSafeSvg } from "./svg-safety.js";
import {
  DEFAULT_TEXT_CLEARANCE_MM,
  coveredCenterlines,
  dashSegments,
  hatchCollisions,
  inkBounds,
  inkOutsideCanvas,
  textClearanceFindings,
} from "./render-check-findings.js";
import { orientation, subpathSegments, textQuad, visiblePieces } from "./render-check-geometry.js";
import { LEADER_ROLE, scanSvg } from "./render-check-scan.js";
import type {
  DrawnSegment,
  InkBounds,
  Occluder,
  Poly,
  RenderCheckFinding,
  RenderCheckReport,
  Segment,
} from "./render-check-types.js";

export type {
  InkBounds,
  RenderCheckFinding,
  RenderCheckKind,
  RenderCheckReport,
} from "./render-check-types.js";

export function measureInkBounds(svg: string, options: { maxBytes?: number } = {}): InkBounds | undefined {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES);
  return inkBounds(scanSvg(svg));
}

/**
 * 量测一张已生成的附图并报告渲染层面才可见的问题。
 *
 * 元素按嵌套逐层继承变换与样式（见模块文档的量测范围）；凡不在范围内的结构，报告
 * `not-measured` 而不是略过。本模块只读文本、不解析实体也不执行任何内容，输入仍过
 * {@link assertSafeSvg} 的实体/CDATA、体量与根元素检查，被拒时抛出。
 *
 * 同一材料的多个轮廓靠绘图侧写的 {@link HATCH_GROUP_ATTRIBUTE} 识别：带同一分组号的
 * 轮廓不互相比较剖面线取向（见 {@link hatchCollisions}）。没有该标注时每个闭合轮廓
 * 各自成组，与标注存在前的判定一致。
 * @param svg - 完整 SVG 文本。
 * @param options - 安全校验上限（字节）；`textClearanceMm` 为标号净距（毫米，默认
 * {@link DEFAULT_TEXT_CLEARANCE_MM}，`0` 关闭该判据）。
 * @returns 量测值与发现的问题。
 * @throws SvgSafetyError 输入未通过 {@link assertSafeSvg} 时。
 */
export function checkFigureRendering(
  svg: string,
  options: { maxBytes?: number; textClearanceMm?: number } = {},
): RenderCheckReport {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES);
  const scan = scanSvg(svg);
  const outlines: Poly[] = [];
  const outlineGroups: (number | undefined)[] = [];
  const openSegments: Segment[] = [];
  const drawn: DrawnSegment[] = [];
  const occluders: Occluder[] = [];
  // 点划线判定用的片段：虚线元素按虚线段展开，其余按整段——`stroke-dasharray` 画出的
  // 中心线不展开就只是一条长线段，点划签名与「被实线覆盖」都看不出来。
  const pieces: Segment[] = [];
  for (const shape of scan.shapes) {
    // 无描边的白填充是背景/挖空（画布底色、文字白边），图面上不承载墨迹：算进图线会把
    // 画布边框报成"贯穿文字的线条"，或让贴着纸边的标号被报"贴线"。
    const drawsInk = shape.stroked || !shape.occludes;
    for (const subpath of shape.subpaths) {
      const segments = subpathSegments(subpath);
      if (drawsInk) {
        drawn.push(...segments.map(segment => ({ segment, order: shape.order, leader: shape.role === LEADER_ROLE })));
      }
      // 不透明填充的闭合轮廓遮挡更早绘制的图元；开放子路径的填充按闭合处理，故不列入。
      if (shape.occludes && subpath.closed) occluders.push({ points: subpath.points, order: shape.order });
      if (subpath.closed) {
        outlines.push(subpath.points);
        outlineGroups.push(shape.hatchGroup);
      } else openSegments.push(...segments);
      for (const segment of segments) {
        if (shape.dashPatternMm === undefined) pieces.push(segment);
        else pieces.push(...dashSegments(segment, shape.dashPatternMm));
      }
    }
  }

  const findings: RenderCheckFinding[] = [];
  if (scan.unmeasured.length > 0) {
    findings.push({
      check: "not-measured",
      message: `以下事实未量测或只作近似：${scan.unmeasured.join("；")}。这些范围内的缺陷不会出现在本报告里，近似项为估计值`,
    });
  }
  const crossed = new Set<number>();
  scan.texts.forEach((text, index) => {
    // 自带白色描边挖空的文字（本仓边标签的契约）不参与贯穿判定：线在字外围被白边断开，
    // 图面上读得出字。见 {@link haloedText}。
    if (text.haloed) return;
    const quad = textQuad(text);
    const hit = drawn.some(item =>
      visiblePieces(item, occluders).some(piece =>
        quadCrossedBySegment(quad, [piece.x1, piece.y1], [piece.x2, piece.y2]),
      ),
    );
    if (!hit) return;
    crossed.add(index);
    findings.push({
      check: "text-crossed-by-line",
      message: `图面文字「${text.content}」被线条贯穿：引线或轮廓线穿过了文字外框；文字应落在零件轮廓或元件符号之外，引线应止于文字外框之外`,
    });
  });
  findings.push(
    ...textClearanceFindings(
      scan.texts,
      drawn,
      occluders,
      options.textClearanceMm ?? DEFAULT_TEXT_CLEARANCE_MM,
      crossed,
    ),
  );
  findings.push(...coveredCenterlines(pieces));
  const ink = inkOutsideCanvas(scan);
  if (ink !== undefined) findings.push(ink);
  findings.push(...hatchCollisions(outlines, openSegments, outlineGroups));

  const strokeCounts = new Map<number, number>();
  for (const shape of scan.shapes) {
    if (!shape.stroked) continue;
    const width = Math.round(shape.strokeWidthMm * 1000) / 1000;
    strokeCounts.set(width, (strokeCounts.get(width) ?? 0) + 1);
  }
  const orientationCounts = new Map<number, number>();
  for (const item of drawn) {
    const key = Math.round(orientation(item.segment) * 10) / 10;
    orientationCounts.set(key, (orientationCounts.get(key) ?? 0) + 1);
  }

  return {
    ...(scan.widthMm === undefined ? {} : { widthMm: scan.widthMm }),
    ...(scan.heightMm === undefined ? {} : { heightMm: scan.heightMm }),
    textCount: scan.texts.length,
    strokeWidthMm: [...strokeCounts]
      .map(([stroke, count]) => ({ widthMm: stroke, count }))
      .sort((left, right) => left.widthMm - right.widthMm),
    orientationDeg: [...orientationCounts]
      .map(([value, count]) => ({ orientationDeg: value, count }))
      .sort((left, right) => right.count - left.count),
    findings,
  };
}
