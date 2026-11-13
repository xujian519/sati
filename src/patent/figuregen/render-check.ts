/**
 * 附图渲染复核（纯函数，无 IO）：在**已生成的 SVG 源**上量测图面事实，报告只有
 * 看渲染结果才看得见的问题。
 *
 * 为什么量测矢量源而不是位图：矢量源是渲染的唯一输入，线段位置、线宽与字号都在
 * 其中；位图量测要引入栅格化器（rsvg/ImageMagick），而本包的两条渲染通路都不
 * 依赖它们。凡「画出来是什么样」取决于矢量源的地方，本模块都按同一条遍历量测。
 *
 * 覆盖七类只在渲染结果上显现的缺陷（前四类来自实测案例）：
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
 * - **图元互相重叠**：两个描边轮廓的边真正互相穿过（包围盒相交只作预筛；排除严格包含、
 *   同组轮廓与贴边相接），两个零件/图形压叠时图面上读不出各自边界。
 * - **字高低于下限**（`minFontMm` 由调用方按法域档案给出）：逐**文字元素**量测字高，
 *   能报出「节点字够大、边标签不够」这类 V7 用渲染器常数估不出的情形。
 * - **版面利用率不足**（`minSheetFillRatio` 由调用方按部署策略给出，缺省不判）：图面墨迹
 *   只占画布的一小部分时，缩小复制后细节更难辨认。这是**提示级**发现（advisory），
 *   不是规范缺陷——它没有条文依据，只值得人看一眼。
 *
 * 图型豁免：根元素声明 {@link SVG_FIGURE_KIND_ATTRIBUTE}=`chart` 时，「相邻零件剖面线」
 * 与「图元互相重叠」**不参与**——曲线图的数据标记与图例符号天然互相叠靠，这两条判据在
 * 该图型上只会报出噪音；豁免同时记一条 `not-measured` 明示未量测（AGENTS 第 11 条）。
 * 外部 SVG 不带该属性，按「图型未知」处理，全部判据照旧参与。
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
 *
 * 另导出两支**纯量测**入口（不产发现）：{@link measureInkBounds}（墨迹包围盒）与
 * {@link measureMinimumFontHeightMm}（实测最小字高）——供「只想要量到的数、不想要
 * 判据结论」的调用方使用（附图核验工具的量测输出面对齐 deepseek-harness 的
 * `verify_patent_figure` 输出）。
 * @module src/patent/figuregen/render-check
 */

import { quadCrossedBySegment } from "./glyph-box.js";
import { DEFAULT_SVG_MAX_BYTES, assertSafeSvg } from "./svg-safety.js";
import {
  DEFAULT_TEXT_CLEARANCE_MM,
  coveredCenterlines,
  dashSegments,
  fontBelowMinimum,
  hatchCollisions,
  inkBounds,
  inkOutsideCanvas,
  outlineOverlaps,
  sheetUnderfill,
  textClearanceFindings,
} from "./render-check-findings.js";
import { isLeaderPlacementError } from "./leader-line.js";
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

/**
 * strict 引线失败发生在出图之前，{@link checkFigureRendering} 没有 SVG 可量。
 * 调用方把 {@link LeaderPlacementError} 交给本函数，得到应写进失败报告的那句话
 * （减少标记、拆图或钉死偏移）。不是引线错误时返回 undefined，避免把别的异常说成择位失败。
 */
export function leaderPlacementFailureMessage(error: unknown): string | undefined {
  if (!isLeaderPlacementError(error)) return undefined;
  return error.message;
}

export function measureInkBounds(svg: string, options: { maxBytes?: number } = {}): InkBounds | undefined {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES);
  return inkBounds(scanSvg(svg));
}

/**
 * 量测一张 SVG 的**最小字高**（毫米，根坐标系）。
 *
 * 字高口径：文字占位框的高（`O→O+e2` 的模长）——它已经是字号换算到根坐标系的结果，
 * 与「文字被贯穿」「标号净距」同一口径（见 {@link checkFigureRendering} 里 RC7 的取法）。
 * 取全部文字元素中的最小值，保留两位小数。
 *
 * 为什么单列一个导出：{@link RenderCheckReport} 的 `minFontMm` 是**下限回显**（调用方
 * 给了下限才回显，判据未参与时缺省），而 deepseek-harness 的 `verify_patent_figure`
 * 输出里的 `minFontMm` 是**实测最小字高**（无文字时缺省）——两者语义不同，不可互相顶替。
 * 需要「这张图最小字高是多少」的调用方（附图核验工具的量测输出面）用本函数。
 *
 * 量测范围与 {@link checkFigureRendering} 一致：不在范围内的结构（CSS 类样式、`<use>`/
 * `<image>` 引用、嵌套 `<svg>` 内层视口等）不参与——本函数只给**量到的**最小值，
 * 缺口由复核报告里的 `not-measured` 发现明示，不在此处推断。
 *
 * 代价：与 {@link checkFigureRendering} 一样各扫一遍 SVG（两次遍历互不干扰，纯函数、
 * 结果确定）。
 * @param svg - 完整 SVG 文本。
 * @param options - 安全校验上限（字节）。
 * @returns 最小字高（毫米）；图中无文字元素时为 undefined。
 * @throws SvgSafetyError 输入未通过 {@link assertSafeSvg} 时。
 */
export function measureMinimumFontHeightMm(svg: string, options: { maxBytes?: number } = {}): number | undefined {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES);
  const scan = scanSvg(svg);
  let minHeightMm: number | undefined;
  for (const text of scan.texts) {
    const quad = textQuad(text);
    const heightMm = Math.round(Math.hypot(quad.edgeHeight[0], quad.edgeHeight[1]) * 100) / 100;
    if (!Number.isFinite(heightMm)) continue;
    if (minHeightMm === undefined || heightMm < minHeightMm) minHeightMm = heightMm;
  }
  return minHeightMm;
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
 * {@link DEFAULT_TEXT_CLEARANCE_MM}，`0` 关闭该判据）；`minFontMm` 为字高下限
 * （毫米，缺省不判——调用方按法域档案给出才有合规意义）。
 * @returns 量测值与发现的问题。
 * @throws SvgSafetyError 输入未通过 {@link assertSafeSvg} 时。
 */
/**
 * 图元按设计相交的图型（RC4/RC6 不适用）。
 *
 * - `chart`：数据标记与图例符号天然叠靠；
 * - `sequence`：消息箭头必须落在生命线上；
 * - `circuit`：连线必须落在元件引线端点；
 * - `panels`：格内图形必然与格边框相交。
 *
 * 根元素用 `data-dsh-kind` 声明（见 `SVG_FIGURE_KIND_ATTRIBUTE`）——**只对这几类写**，
 * 既有图型的产物字节保持不变（渲染不变式基线不漂）。
 */
const OVERLAP_EXEMPT_KINDS: ReadonlySet<string> = new Set(["chart", "sequence", "circuit", "panels"]);

export function checkFigureRendering(
  svg: string,
  options: {
    maxBytes?: number;
    textClearanceMm?: number;
    minFontMm?: number;
    /** 版面利用率下限（0–1）：缺省不判（部署级 opt-in，见 {@link sheetUnderfill}）。 */
    minSheetFillRatio?: number;
  } = {},
): RenderCheckReport {
  assertSafeSvg(svg, options.maxBytes ?? DEFAULT_SVG_MAX_BYTES);
  const scan = scanSvg(svg);
  const outlines: Poly[] = [];
  const outlineGroups: (number | undefined)[] = [];
  const outlineStroked: boolean[] = [];
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
        // 只把**承载墨迹**的闭合轮廓当作零件轮廓：画布白底（白填充、不描边）也是闭合
        // 子路径，但它不是零件——把它算进来，剖面线会被归到「画布」这一组，于是
        // 「画布 vs 零件 1」被判成「相邻零件剖面线方向相同」（2D 剖视实测踩到）。
        // 判据用「承载墨迹」而非「是否描边」：既有 RC4/RC6 用例里的轮廓是填充不描边的
        // 多边形，按描边过滤会把它们整体排除（回归实测）。
        if (drawsInk) {
          outlines.push(subpath.points);
          outlineGroups.push(shape.hatchGroup);
          outlineStroked.push(shape.stroked);
        }
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
  // 曲线图的数据标记与图例符号天然互相叠靠（实测散点图的相邻标记 0.3×1.2 毫米就互穿、
  // 图例符号的短笔画被当成剖面线）：轮廓类判据在这类图上只会产出噪音，量不出缺陷。
  // 显式记一条 `not-measured`，而不是让"没判"看起来像"判过且无问题"（AGENTS 第 11 条）。
  //
  // 时序图 / 电路图 / 多面板附图同理，且理由更硬：**箭头与引线本来就该相交**——
  // 时序图的消息箭头必须落在生命线上，电路图的连线必须落在元件引线端点，多面板的
  // 格内图形必然与格边框相交 ⇒ RC6（图元互相重叠）在这些图型上恒为真，是噪音不是缺陷。
  if (scan.figureKind !== undefined && OVERLAP_EXEMPT_KINDS.has(scan.figureKind)) {
    const kindLabel =
      scan.figureKind === "chart"
        ? "曲线图（kind=chart）"
        : scan.figureKind === "sequence"
          ? "时序图（kind=sequence）"
          : scan.figureKind === "circuit"
            ? "电路图（kind=circuit）"
            : "多面板附图（panels）";
    findings.push({
      check: "not-measured",
      message:
        `${kindLabel}的图元按设计相交（时序图箭头落在生命线、电路图连线落在引线端点、` +
        "多面板图形与格边框相交）：RC4（相邻零件剖面线难以区分）与 RC6（图元互相重叠）在该图型上" +
        "不适用，本次未量测——RC1/RC2/RC3/RC5/RC7 照常量测",
    });
  } else {
    findings.push(...hatchCollisions(outlines, openSegments, outlineGroups));
    findings.push(...outlineOverlaps(outlines, outlineGroups, outlineStroked));
  }
  if (options.minFontMm !== undefined) {
    // 字高按文字占位框的实际四角量测（O→O+e2 的模长）：与 V7 的「按渲染器常数估算」
    // 互补——这里量的是**每个**文字元素，能看见节点字够大而边标签不够的情形。
    const heightsMm = scan.texts.map(text => {
      const quad = textQuad(text);
      return Math.hypot(quad.edgeHeight[0], quad.edgeHeight[1]);
    });
    findings.push(...fontBelowMinimum(scan.texts, heightsMm, options.minFontMm));
  }
  // 版面利用率（提示级，部署级 opt-in）：缺省不判；启用时产出 advisory 发现，
  // 「不是缺陷、但值得人看一眼」，不计入缺陷数、不阻断交付。
  const underfill = sheetUnderfill(scan, options.minSheetFillRatio);
  if (underfill !== undefined) findings.push(underfill);

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
    ...(options.minFontMm === undefined ? {} : { minFontMm: options.minFontMm }),
    findings,
  };
}
