/**
 * src/patent/figuregen/cad — 投影边表 → 黑白 SVG（复用 Sati 自己的渲染契约）。
 *
 * 为什么不直接用 FreeCAD 的 `projectToSVG`：那会引入**第二套交付契约**（颜色/线宽/
 * 版式/data-ref 都要重新归一化，实测其默认样式是 `rgb(0, 0, 0)`，会被本模块的
 * `assertBlackWhite` 判非黑白）。改为：FreeCAD 只给 JSON 边表，SVG 由本模块产出 ⇒
 * 黑白不变式、图号标注、A4 版式、回读自检全部复用既有实现。
 *
 * **朝向对齐**（纯函数，可用录制的边表单测）：实测 `TechDraw.project` 的坐标系由它自己
 * 决定（front 视图里 u 对应 -Z），故 Python 侧另投影四个单位参考体给出模型原点与各轴的像
 * （`axes`）；本模块按视图定义"屏幕右轴/屏幕上轴"，用点积把 (u,v) 映射为屏幕坐标：
 *
 *   x_screen = (u,v)·normalize(image(right))    y_screen = −(u,v)·normalize(image(up))
 *
 * 模型坐标 → 投影坐标的仿射映射由 `projectModelPoints`（`types.ts`）给出——**剖切面轮廓
 * 与附图标记锚点的投影都在这一处**，FreeCAD 侧不重复实现投影。
 *
 * 视图配置（纸面朝向）取"模型竖直轴在图上竖直"的常规约定；**投影法（第一角/第三角）的
 * 纸面配置属交付排版约定**，本模块不声称遵循其中之一（需按最终申请格式复核）。
 */

import { figureCaption, officeProfile, printableArea } from "../office-profile.js";
import { planLeaderLines, type LeaderSegment } from "../leader-line.js";
import { measureTextWidth } from "../metrics.js";
import { escapeXml, fmt as fmtShared } from "../render-utils.js";
import type { Jurisdiction } from "../types.js";
import {
  projectModelPoints,
  type CadAxisImages,
  type CadCutFace,
  type CadEdge,
  type CadEdgeTable,
  type CadView,
} from "./types.js";

/** 屏幕右轴/上轴（模型坐标，单位向量）。 */
type ScreenAxes = { right: readonly [number, number, number]; up: readonly [number, number, number] };

export const CAD_VIEW_SCREEN_AXES: Record<CadView, ScreenAxes> = {
  front: { right: [1, 0, 0], up: [0, 0, 1] },
  back: { right: [-1, 0, 0], up: [0, 0, 1] },
  left: { right: [0, -1, 0], up: [0, 0, 1] },
  right: { right: [0, 1, 0], up: [0, 0, 1] },
  top: { right: [1, 0, 0], up: [0, 1, 0] },
  bottom: { right: [1, 0, 0], up: [0, -1, 0] },
  // 轴测图：屏幕右/上取模型 +X / +Z 的像（得到常规轴测朝向；其"正确"朝向无唯一约定）
  iso: { right: [1, 0, 0], up: [0, 0, 1] },
};

/** 附图标记标注（模型坐标锚点 → 图面引线 + 标号）。 */
export type CadRefAnnotation = {
  /** 附图标记（与说明书文字部分的核验对象）。 */
  ref: number;
  /** 标记锚点（模型坐标，毫米）：投影后作为引线起点。 */
  atMm: readonly [number, number, number];
  /**
   * 标号相对锚点的图面偏移（毫米，+x 向右、+y 向下；SVG 坐标系）。
   * 缺省按"远离图心"方向自动放置（常规制图做法：标号向图外引）。
   */
  labelOffsetMm?: readonly [number, number];
};

export type CadRenderOptions = {
  /** 图号（SVG 图号标注"图N"，细则第 21 条式样）。 */
  figureNo: number;
  jurisdiction?: Jurisdiction;
  /** 本案附图总幅数（图号是否需要标注由图幅数与法域档案共同决定；缺省 1）。 */
  figureCount?: number;
  /** 是否绘制隐藏线（**默认关**：CNIPA 实务以剖视图表达内部结构，虚线易与标记线混淆）。 */
  hiddenLines?: boolean;
  /** 图面外边距（毫米）。 */
  marginMm?: number;
  /** 附图标记标注（缺省无标注：出未标注的投影图）。 */
  annotations?: readonly CadRefAnnotation[];
};

/** 标号在图面上的落位（纸面毫米；供标注规则检查与报告）。 */
export type CadLabelPlacement = {
  ref: number;
  /** 引线起点（锚点投影，纸面毫米）。 */
  anchorMm: [number, number];
  /** 标号锚点（纸面毫米；文本水平居中于此、基线落于此）。 */
  labelMm: [number, number];
  /** 文本包围盒（纸面毫米；按 `measureTextWidth` 估算，用于重叠/越界判定）。 */
  boxMm: { left: number; top: number; right: number; bottom: number };
  /** 引线折线（纸面毫米）；退化为就地标号时为空。 */
  leaderMm: readonly LeaderSegment[];
  /** 是否退化（无可用引线落位：标号就地画在锚点上）。 */
  degraded: boolean;
  /**
   * 钉死偏移（`label_offset_mm`）的后果（引线面 + 标号压盖图内内容）。引擎择位的落位恒为空
   * ——见 `leader-line.ts` 的判据。
   */
  conflicts: readonly string[];
};

export type CadRenderResult = {
  svg: string;
  /** 纸面尺寸（毫米，含外边距与标注预留带）。 */
  widthMm: number;
  heightMm: number;
  /** 缩放系数（把几何适配进可印区；≤ 100% 时不放大）。 */
  scale: number;
  /** 可见/隐藏边数（供几何级检查与报告）。 */
  visibleEdges: number;
  hiddenEdges: number;
  /** 剖切面数（0 = 整视图，无剖面线）。 */
  cutFaces: number;
  /** 剖面线段数（0 而 cutFaces > 0 说明剖切面过小，剖面线无法表达）。 */
  hatchSegments: number;
  /** 标注落位（缺省无标注时为空数组）。 */
  labels: CadLabelPlacement[];
  /** 标注择位告警（无可用引线落位 ⇒ 退化就地标号；缺省无标注时为空数组）。 */
  labelWarnings: string[];
  /** 绘制几何（不含标注）的纸面范围：判定"锚点是否落在图内"用。 */
  geometryBoundsMm: { left: number; top: number; right: number; bottom: number };
};

const DEFAULT_MARGIN_MM = 6;
/** 线宽（毫米）：专利附图线条通常 0.25–0.5mm，取 0.35mm。 */
export const CAD_LINE_WIDTH_MM = 0.35;
/** 隐藏线虚线样式（mm）。 */
export const CAD_HIDDEN_DASH_MM: readonly [number, number] = [1.5, 1];
/** 剖面线（细实线）线宽与间距（毫米，纸面）：间距指相邻剖面线的垂直距离。 */
export const CAD_HATCH_LINE_WIDTH_MM = 0.2;
export const CAD_HATCH_SPACING_MM = 2.5;
/** 附图标记标号字号（毫米，纸面）与引线长度（毫米，纸面）。 */
export const CAD_REF_FONT_MM = 3.0;
export const CAD_REF_LEADER_MM = 6;
/** 引线止于标号外缘的间隙（毫米，纸面）。 */
export const CAD_REF_LABEL_GAP_MM = 1.5;
/** 标注预留带的额外余量（毫米，纸面）：标号外缘与可印区之间留白。 */
export const CAD_REF_RESERVE_PAD_MM = 1;
/** 预留带上限（占可印区比例）：防止调用方给出离谱偏移后把几何压到不可见。 */
export const CAD_MAX_RESERVE_RATIO = 0.2;

function dot(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] * b[0] + a[1] * b[1];
}

function normalize(vector: readonly [number, number]): [number, number] | undefined {
  const length = Math.hypot(vector[0], vector[1]);
  if (length < 1e-9) return undefined;
  return [vector[0] / length, vector[1] / length];
}

/**
 * 屏幕坐标映射（纯函数）。轴像退化（某轴的像长度为 0，即该轴正对视线）时返回 undefined
 * ——此时屏幕右/上轴在该视图下不可定义，调用方须 fail-loud 而不是出一张朝向不明的图。
 */
export function buildScreenTransform(
  axes: CadAxisImages,
  view: CadView,
): { x: (u: number, v: number) => number; y: (u: number, v: number) => number } | undefined {
  const spec = CAD_VIEW_SCREEN_AXES[view];
  const imageOf = (axis: readonly [number, number, number]): [number, number] | undefined => {
    const u = axis[0] * axes.x[0] + axis[1] * axes.y[0] + axis[2] * axes.z[0];
    const v = axis[0] * axes.x[1] + axis[1] * axes.y[1] + axis[2] * axes.z[1];
    return normalize([u, v]);
  };
  const rightImage = imageOf(spec.right);
  const upImage = imageOf(spec.up);
  if (rightImage === undefined || upImage === undefined) return undefined;
  return {
    x: (u, v) => dot([u, v], rightImage),
    // SVG 的 y 向下：屏幕坐标 y = −（沿"上轴"的投影分量），故模型上方 = 更小的 y
    y: (u, v) => -dot([u, v], upImage),
  };
}

/**
 * CAD 投影坐标精度：3 位小数（纸面毫米，微米级）。
 *
 * 精密图形不能像流程图那样只留 1 位——投影边与剖面线的端点靠坐标本身表达，取整到 0.1mm
 * 会让细结构的相对位置失真。
 */
const CAD_COORD_DIGITS = 3;

const fmt = (value: number): string => fmtShared(value, CAD_COORD_DIGITS);

/**
 * 多边形剖面线（45°，纸面毫米间距；扫描线 + 奇偶规则，纯函数）。
 *
 * 在旋转到 45° 的坐标系里做横向扫描线：`X=(x+y)/√2, Y=(y−x)/√2` ⇒ 剖面线即 `Y=const`，
 * 相邻线在纸面上的垂直距离恰为 `spacingMm`。奇偶规则使多环（外环 + 孔/缺口内环）
 * 自动留空，无需单独处理洞。
 *
 * 扫描线相位对齐全局网格（`Y = ceil(Ymin/间距)·间距`）：同一张图的两处剖切面剖面线
 * 相位一致，且结果与调用顺序无关（确定性）。
 */
export function hatchPolylines(
  loops: readonly (readonly (readonly [number, number])[])[],
  spacingMm: number,
): [number, number][][] {
  if (spacingMm <= 0 || loops.length === 0) return [];
  const k = Math.SQRT1_2;
  const rotate = ([x, y]: readonly [number, number]): [number, number] => [(x + y) * k, (y - x) * k];
  const unrotate = ([x, y]: readonly [number, number]): [number, number] => [(x - y) * k, (x + y) * k];
  const rotated = loops.map(loop => loop.map(rotate));
  const allY = rotated.flatMap(loop => loop.map(point => point[1]));
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const edges: [readonly [number, number], readonly [number, number]][] = [];
  for (const loop of rotated) {
    for (let index = 0; index < loop.length; index += 1) {
      edges.push([loop[index]!, loop[(index + 1) % loop.length]!]);
    }
  }
  const segments: [number, number][][] = [];
  const first = Math.ceil(minY / spacingMm - 1e-9) * spacingMm;
  for (let y = first; y <= maxY + 1e-9; y += spacingMm) {
    const crossings: number[] = [];
    for (const [a, b] of edges) {
      // 半开区间（含下端点、不含上端点）：扫描线穿过顶点时只计一次，避免成对错配
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        crossings.push(a[0] + t * (b[0] - a[0]));
      }
    }
    crossings.sort((left, right) => left - right);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = crossings[index]!;
      const to = crossings[index + 1]!;
      if (to - from < 1e-9) continue;
      segments.push([unrotate([from, y]), unrotate([to, y])]);
    }
  }
  return segments;
}

/**
 * 剖切面轮廓（模型坐标）→ 纸面多边形。
 *
 * `toPaper` 的入参是**图面局部坐标**（屏幕 y 向下），故必须先经屏幕变换：模型坐标 →
 * 投影坐标 (u,v) → 屏幕坐标，缺任一环都会把剖面线画到剖切面之外（朝向对齐在各视图上
 * 是轴交换 + 翻转，漏掉它时画出的是一张转置/镜像的影子）。
 */
function cutFacePolylines(
  cutFaces: readonly CadCutFace[],
  toPaperFromModel: (point: readonly [number, number, number]) => [number, number],
): [number, number][][][] {
  return cutFaces.map(face => face.loops.map(loop => loop.map(point => toPaperFromModel(point))));
}

/** 投影边表 → 黑白 SVG（A4 可印区适配；确定性：无时钟/随机）。 */
export function renderCadSvg(table: CadEdgeTable, options: CadRenderOptions): CadRenderResult {
  const hiddenLines = options.hiddenLines === true;
  const margin = options.marginMm ?? DEFAULT_MARGIN_MM;
  const annotations = options.annotations ?? [];
  const drawn: CadEdge[] = table.edges.filter(edge => edge.kind === "visible" || hiddenLines);
  if (drawn.length === 0) {
    throw new TypeError(`视图 ${table.view} 没有可绘制的${hiddenLines ? "" : "可见"}边——请改用其他视图或开启隐藏线`);
  }
  const transform = buildScreenTransform(table.axes, table.view);
  if (transform === undefined) {
    throw new TypeError(
      `视图 ${table.view} 的投影坐标系无法对齐（屏幕右轴或上轴在投影平面退化为一点）——该视图方向与此视图配置不兼容`,
    );
  }

  const localFromUv = (u: number, v: number): [number, number] => [transform.x(u, v), transform.y(u, v)];
  const localFromModel = (point: readonly [number, number, number]): [number, number] => {
    const [u, v] = projectModelPoints(table.axes, [point])[0]!;
    return localFromUv(u, v);
  };
  const projected = drawn.map(edge => ({ edge, points: edge.points.map(([u, v]) => localFromUv(u, v)) }));
  const xs = projected.flatMap(entry => entry.points.map(point => point[0]));
  const ys = projected.flatMap(entry => entry.points.map(point => point[1]));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const geometryWidth = Math.max(1e-6, maxX - minX);
  const geometryHeight = Math.max(1e-6, maxY - minY);

  // 标注预留带：标号向图外引，故四边各留出"最长引线 + 半个最宽标号 + 余量"。
  // 有预留带 ⇒ 含标注的纸面尺寸**由构造保证**不超可印区（几何另按可用宽度缩放）。
  // 预留带同时是择位引擎的**画幅约束**：带内放不下候选时引擎不硬画（那会被裁或压图），
  // 而是把标号退化为就地标注并告警（见 leader-line.ts）。
  const profile = officeProfile(
    options.jurisdiction === "us" ? "uspto" : options.jurisdiction === "pct" ? "pct" : "cnipa",
  );
  const area = printableArea(profile);
  const anchorsLocal = annotations.map(annotation => localFromModel(annotation.atMm));
  const reserve = (() => {
    if (annotations.length === 0) return 0;
    let needed = 0;
    for (const annotation of annotations) {
      const offset = annotation.labelOffsetMm;
      const reach = offset === undefined ? CAD_REF_LEADER_MM : Math.hypot(offset[0], offset[1]);
      const halfWidth = measureTextWidth(String(annotation.ref), CAD_REF_FONT_MM) / 2;
      needed = Math.max(needed, Math.min(reach, CAD_REF_LEADER_MM * 6) + halfWidth + CAD_REF_RESERVE_PAD_MM);
    }
    const cap = Math.min(area.widthMm, area.heightMm) * CAD_MAX_RESERVE_RATIO;
    return Math.min(needed, cap);
  })();

  const availableWidth = area.widthMm - margin * 2 - reserve * 2;
  const availableHeight = area.heightMm - margin * 2 - reserve * 2;
  const scale = Math.min(1, availableWidth / geometryWidth, availableHeight / geometryHeight);
  const band = margin + reserve;
  const widthMm = geometryWidth * scale + band * 2;
  const heightMm = geometryHeight * scale + band * 2;

  const toPaper = (x: number, y: number): [number, number] => [band + (x - minX) * scale, band + (y - minY) * scale];

  const geometryBoundsMm = {
    left: band,
    top: band,
    right: band + geometryWidth * scale,
    bottom: band + geometryHeight * scale,
  };

  // 纸面折线只算一次：SVG 路径与"引线不得与之共线"的障碍线段同源（两处各算一遍必然漂移）
  const paperPolylines = projected.map(entry => ({
    edge: entry.edge,
    points: entry.points.map(([x, y]) => toPaper(x, y)),
  }));

  const paths = paperPolylines
    .map(entry => {
      const points = entry.points.map(([sx, sy]) => `${fmt(sx)},${fmt(sy)}`);
      const style =
        `fill="none" stroke="#000000" stroke-width="${CAD_LINE_WIDTH_MM}"` +
        (entry.edge.kind === "hidden" ? ` stroke-dasharray="${CAD_HIDDEN_DASH_MM[0]} ${CAD_HIDDEN_DASH_MM[1]}"` : "");
      return `<polyline points="${points.join(" ")}" ${style}/>`;
    })
    .join("\n");

  // 剖面线：剖切面轮廓 → 纸面多边形 → 45° 扫描线填充（细实线，先于轮廓绘制）
  const cutFaces = table.cutFaces ?? [];
  const toPaperFromModel = (point: readonly [number, number, number]): [number, number] => {
    const [x, y] = localFromModel(point);
    return toPaper(x, y);
  };
  const hatchSegments: [number, number][][] = [];
  for (const loops of cutFacePolylines(cutFaces, toPaperFromModel)) {
    hatchSegments.push(...hatchPolylines(loops, CAD_HATCH_SPACING_MM));
  }
  const hatchPath =
    hatchSegments.length === 0
      ? ""
      : `<path d="${hatchSegments
          .map(([from, to]) => `M${fmt(from[0])} ${fmt(from[1])}L${fmt(to[0])} ${fmt(to[1])}`)
          .join("")}" fill="none" stroke="#000000" stroke-width="${CAD_HATCH_LINE_WIDTH_MM}"/>\n`;

  // 附图标记：锚点投影 → 择位（引线 + 标号）。分组 id 形如 "n-ref-<标记>"，与内置渲染器的
  // 回读契约同构（patent_figure_check 的 svg_paths 回读可直接复核 CAD 图）。
  //
  // 择位交给 leader-line.ts：标号不压图内内容、引线不与主线条共线重叠、引线之间不交叉。
  // 障碍分两类、口径不同——几何外接框只约束**标号**（锚点在零件内部时，引线要出图必然穿过
  // 外接框，那是常规制图形态），线条才约束**引线**（共线重叠即分不清标记线与主线条）。
  const centerPaper: [number, number] = [
    (geometryBoundsMm.left + geometryBoundsMm.right) / 2,
    (geometryBoundsMm.top + geometryBoundsMm.bottom) / 2,
  ];
  const obstacleSegments: LeaderSegment[] = [];
  for (const entry of paperPolylines) {
    for (let index = 1; index < entry.points.length; index += 1) {
      const [x1, y1] = entry.points[index - 1]!;
      const [x2, y2] = entry.points[index]!;
      obstacleSegments.push({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
    }
  }
  for (const [from, to] of hatchSegments) {
    obstacleSegments.push({ from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } });
  }
  const plan = planLeaderLines(
    annotations.map((annotation, index) => {
      const [x, y] = toPaper(...anchorsLocal[index]!);
      return {
        id: String(annotation.ref),
        text: String(annotation.ref),
        anchor: { x, y },
        ...(annotation.labelOffsetMm === undefined ? {} : { pinnedOffsetMm: annotation.labelOffsetMm }),
      };
    }),
    { boxes: [geometryBoundsMm], segments: obstacleSegments },
    {
      fontSizeMm: CAD_REF_FONT_MM,
      gapMm: CAD_REF_LABEL_GAP_MM,
      minLeaderMm: CAD_REF_LEADER_MM,
      // 引线上限取几何对角尺度：锚点在零件深处时必须能一路引到图外（缺省 6mm 够不到中心）
      maxLeaderMm:
        Math.max(geometryBoundsMm.right - geometryBoundsMm.left, geometryBoundsMm.bottom - geometryBoundsMm.top) *
          0.75 +
        CAD_REF_LEADER_MM,
      canvas: { left: 0, top: 0, right: widthMm, bottom: heightMm },
      figureCenter: { x: centerPaper[0], y: centerPaper[1] },
    },
  );
  // 落位按目标顺序返回（leader-line.ts 的顺序纪律），故与 annotations 逐位对齐：
  // 标记取值直接取原 annotation，不从 id 反解（避免未来换成非数字 id 时静默变 NaN）。
  const labels: CadLabelPlacement[] = plan.placements.map((placement, index) => ({
    ref: annotations[index]!.ref,
    anchorMm: [placement.anchor.x, placement.anchor.y],
    labelMm: [placement.labelPoint.x, placement.labelPoint.y],
    boxMm: placement.box,
    leaderMm: placement.leader,
    degraded: placement.degraded,
    conflicts: placement.conflicts,
  }));
  const annotationMarkup = plan.placements
    .map(placement => {
      const leader = placement.leader
        .map(
          segment =>
            `<polyline points="${fmt(segment.from.x)},${fmt(segment.from.y)} ` +
            `${fmt(segment.to.x)},${fmt(segment.to.y)}" fill="none" stroke="#000000" ` +
            `stroke-width="${CAD_LINE_WIDTH_MM}"/>`,
        )
        .join("");
      return (
        `<g id="n-ref-${placement.id}" data-ref="${placement.id}">${leader}` +
        `<text x="${fmt(placement.labelPoint.x)}" y="${fmt(placement.labelPoint.y)}" font-size="${CAD_REF_FONT_MM}" ` +
        `text-anchor="middle" fill="#000000">${escapeXml(placement.text)}</text></g>`
      );
    })
    .join("\n");

  const caption = figureCaption(profile, options.figureNo, options.figureCount ?? 1);
  const captionY = heightMm - 2;
  const captionMarkup =
    caption === undefined
      ? ""
      : `<text x="${fmt(widthMm / 2)}" y="${fmt(captionY)}" font-size="3.5" text-anchor="middle" fill="#000000">` +
        `${escapeXml(caption)}</text>\n`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(widthMm)}mm" height="${fmt(heightMm)}mm" ` +
    `viewBox="0 0 ${fmt(widthMm)} ${fmt(heightMm)}" font-family="sans-serif">\n` +
    `<rect x="0" y="0" width="${fmt(widthMm)}" height="${fmt(heightMm)}" fill="#FFFFFF"/>\n` +
    `${hatchPath}${paths}\n` +
    (annotationMarkup.length > 0 ? `${annotationMarkup}\n` : "") +
    captionMarkup +
    `</svg>\n`;

  return {
    svg,
    widthMm,
    heightMm,
    scale,
    visibleEdges: table.edges.filter(edge => edge.kind === "visible").length,
    hiddenEdges: table.edges.filter(edge => edge.kind === "hidden").length,
    cutFaces: cutFaces.length,
    hatchSegments: hatchSegments.length,
    labels,
    labelWarnings: plan.warnings,
    geometryBoundsMm,
  };
}
