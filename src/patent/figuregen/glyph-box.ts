/**
 * 文字占位框（纯函数，无 IO）：图面把文字画成 `<text>`，其可见范围按字号估算。
 *
 * 绘图侧（引线止点、元件名落位）与复核侧（文字是否被线条穿过）共用本模型的唯一原因：
 * 两侧对「字占多大」的判断必须一致，否则一侧按较松的框躲避、另一侧按较紧的框判定，
 * 会把正确的图报成缺陷。框以基线锚点定位：上方 {@link GLYPH_ASCENT_RATIO} 倍字号、
 * 下方 {@link GLYPH_DESCENT_RATIO} 倍字号；宽度逐码点累加，全角字符按
 * {@link FULL_WIDTH_RATIO}、其余按 {@link GLYPH_WIDTH_RATIO}。判定同样共用：线段须在
 * 框内进入至少 {@link GLYPH_BOX_TOLERANCE_MM} 才算穿过（{@link boxCrossedBySegment}
 * 与 {@link quadCrossedBySegment} 是同一判定的轴对齐形式与仿射形式），贴边、沿边共线、
 * 只在角上掠过都不算。复核侧的「标号净距」判据把框按 {@link inflateQuad} 外扩净距后
 * 再用同一判定，故「贴线多远才算缺陷」也只有一处定义。
 * @module src/patent/figuregen/glyph-box
 */

/** 西文小写字母与数字的宽度与字号之比。 */
export const GLYPH_WIDTH_RATIO = 0.6;
/** 西文大写字母的宽度与字号之比。 */
export const UPPER_WIDTH_RATIO = 0.75;
/** 全角字符（中日韩文字、谚文、全角标点）宽度与字号之比。 */
export const FULL_WIDTH_RATIO = 1;
/** 基线以上的高度与字号之比。 */
export const GLYPH_ASCENT_RATIO = 0.75;
/** 基线以下的深度与字号之比。 */
export const GLYPH_DESCENT_RATIO = 0.12;
/**
 * 占位框的「已在框内」容差（毫米）：引线止点按占位框边界求解，而 SVG 坐标保留三位小数，
 * 止点可能落在边界上或落进 0.0005 毫米；贴着框边不算穿过（字身离框边还有余量），只有
 * 真正进入框内才报。
 *
 * 本文件的比例与容差全部沿用 deepseek-harness 的默认值（含其 Inkscape 实测口径），
 * 非本仓条文核验过的法条数值。
 */
export const GLYPH_BOX_TOLERANCE_MM = 0.01;

/**
 * 全角码点区间（含首尾）：Unicode East Asian Width 取 W 与 F 的常用范围。逐码点
 * 查表而非用正则：ECMAScript 只支持 General_Category 与 Script 属性，没有
 * East_Asian_Width。
 */
const FULL_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // 中日韩部首扩展、中日韩符号与标点
  [0x3041, 0x33ff], // 平假名、片假名、注音、中日韩兼容
  [0x3400, 0x4dbf], // 中日韩统一表意文字扩展 A
  [0x4e00, 0x9fff], // 中日韩统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // 中日韩兼容表意文字
  [0xfe30, 0xfe6f], // 中日韩兼容形式
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x3fffd], // 中日韩统一表意文字扩展 B 及以后
];

/** 文字水平对齐方式（与 SVG `text-anchor` 同义）。 */
export type GlyphTextAnchor = "start" | "middle" | "end";

/** 轴对齐矩形（用户单位）。 */
export type GlyphBox = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/** 西文大写字母的码点区间（含首尾）。 */
const UPPER_RANGE: readonly [number, number] = [0x41, 0x5a];

/**
 * 内容宽度（毫米）：逐码点累加，全角字符占一个字号、西文大写字母按
 * {@link UPPER_WIDTH_RATIO}、其余按 {@link GLYPH_WIDTH_RATIO}。
 *
 * 比例取自本机实测（Inkscape 1.4.4 的 `--query-all` 量测墨迹宽 / 字号 / 字数）：
 * 汉字 0.96、全角标点 0.65、数字 0.62、小写 0.51、大写混排 0.63–0.73、`MWWM` 0.87。
 * 电器件名常用全大写缩写，按小写的比例量测会把框算窄三成，故单列大写。
 * @param content - 文字内容。
 * @param fontSizeMm - 字号（毫米）。
 * @returns 估算的排版宽度（毫米）。
 */
export function textWidthMm(content: string, fontSizeMm: number): number {
  let ratio = 0;
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (FULL_WIDTH_RANGES.some(([from, to]) => code >= from && code <= to)) ratio += FULL_WIDTH_RATIO;
    else if (code >= UPPER_RANGE[0] && code <= UPPER_RANGE[1]) ratio += UPPER_WIDTH_RATIO;
    else ratio += GLYPH_WIDTH_RATIO;
  }
  return ratio * fontSizeMm;
}

/**
 * 文字占位框。
 * @param content - 文字内容（决定宽度）。
 * @param baseline - 基线锚点（SVG `<text>` 的 x/y）。
 * @param fontSizeMm - 字号（毫米）。
 * @param anchor - 水平对齐方式。
 * @returns 占位框。
 */
export function glyphBox(
  content: string,
  baseline: readonly [number, number],
  fontSizeMm: number,
  anchor: GlyphTextAnchor,
): GlyphBox {
  const width = textWidthMm(content, fontSizeMm);
  const left = anchor === "middle" ? baseline[0] - width / 2 : anchor === "end" ? baseline[0] - width : baseline[0];
  return {
    minX: left,
    maxX: left + width,
    minY: baseline[1] - fontSizeMm * GLYPH_ASCENT_RATIO,
    maxY: baseline[1] + fontSizeMm * GLYPH_DESCENT_RATIO,
  };
}

/**
 * 仿射矩形：`origin` 顶点与两条边向量（占位框本身，或占位框经变换后的像）。
 */
export type GlyphQuad = {
  /** 顶点（占位框左上角或其在图面上的像）。 */
  readonly origin: readonly [number, number];
  /** 宽度方向的边向量（自 `origin` 指向同一条边的另一端）。 */
  readonly edgeWidth: readonly [number, number];
  /** 高度方向的边向量（自 `origin` 指向下一条边的起端）。 */
  readonly edgeHeight: readonly [number, number];
};

/**
 * 占位框 → 仿射矩形。
 * @param box - 占位框。
 * @returns 该框的仿射矩形。
 */
export function boxQuad(box: GlyphBox): GlyphQuad {
  return {
    origin: [box.minX, box.minY],
    edgeWidth: [box.maxX - box.minX, 0],
    edgeHeight: [0, box.maxY - box.minY],
  };
}

/** 把二维向量化为单位向量；零向量原样返回。 */
function unitVector(vector: readonly [number, number]): readonly [number, number] {
  const length = Math.hypot(vector[0], vector[1]);
  return length === 0 ? [0, 0] : [vector[0] / length, vector[1] / length];
}

/**
 * 把仿射矩形沿两条边各自的方向向外扩 `clearanceMm`：原点后退、两条边向量各自加长两倍净距。
 *
 * 矩形上「宽边」的法向就是高边的方向（反之亦然），故沿边方向外扩等价于沿该边的法向
 * 留出净距——轴对齐的占位框因此得到「四周各外扩净距」的矩形，任意旋转的文字框得到
 * 同样旋转的放大矩形。退化矩形（字号为零）原样返回。
 * @param quad - 仿射矩形（占位框或其在图面上的像）。
 * @param clearanceMm - 净距（毫米）。
 * @returns 外扩后的仿射矩形。
 */
export function inflateQuad(quad: GlyphQuad, clearanceMm: number): GlyphQuad {
  const width = unitVector(quad.edgeWidth);
  const height = unitVector(quad.edgeHeight);
  return {
    origin: [
      quad.origin[0] - clearanceMm * (width[0] + height[0]),
      quad.origin[1] - clearanceMm * (width[1] + height[1]),
    ],
    edgeWidth: [quad.edgeWidth[0] + 2 * clearanceMm * width[0], quad.edgeWidth[1] + 2 * clearanceMm * width[1]],
    edgeHeight: [quad.edgeHeight[0] + 2 * clearanceMm * height[0], quad.edgeHeight[1] + 2 * clearanceMm * height[1]],
  };
}

/**
 * 把参数区间收窄到 `value0 + t·(value1 - value0)` 落在 `(low, high)` 内的部分。
 * @param range - 当前可行区间。
 * @param value0 - `t=0` 处的取值。
 * @param value1 - `t=1` 处的取值。
 * @param low - 取值下界（开区间）。
 * @param high - 取值上界（开区间）。
 * @returns 收窄后的区间；无解时 undefined。
 */
function clipInterval(
  range: readonly [number, number],
  value0: number,
  value1: number,
  low: number,
  high: number,
): [number, number] | undefined {
  if (value0 === value1) return value0 > low && value0 < high ? [range[0], range[1]] : undefined;
  const atLow = (low - value0) / (value1 - value0);
  const atHigh = (high - value0) / (value1 - value0);
  const lower = Math.max(range[0], Math.min(atLow, atHigh));
  const upper = Math.min(range[1], Math.max(atLow, atHigh));
  return lower < upper ? [lower, upper] : undefined;
}

/**
 * 线段是否穿过仿射矩形：线段上有一段落在矩形内部，且离每条边至少
 * {@link GLYPH_BOX_TOLERANCE_MM}。
 *
 * 判据是「进入多深」而不是「是否与边相交」：引线止点由 {@link leaderEnd} 解在占位框
 * 边界上，而坐标只保留三位小数，止点会落在边界内侧 1e-15 毫米量级处——按相交判定，
 * 工具自己画的引线会被报成「贯穿文字」。沿边共线、只在角上掠过同样不算。绘图侧
 * （引线避让、标号落位）与复核侧（判图面缺陷）共用本判定，两侧口径因此完全一致。
 * @param quad - 仿射矩形。
 * @param from - 线段起点。
 * @param to - 线段终点。
 * @returns 穿过时 true。
 */
export function quadCrossedBySegment(
  quad: GlyphQuad,
  from: readonly [number, number],
  to: readonly [number, number],
): boolean {
  const { origin, edgeWidth: width, edgeHeight: height } = quad;
  const determinant = width[0] * height[1] - width[1] * height[0];
  // 退化矩形（边向量共线或为零，如字号为零的文字）没有内部，不判穿过。
  if (determinant === 0) return false;
  const coordinate = (point: readonly [number, number]): readonly [number, number] => [
    ((point[0] - origin[0]) * height[1] - (point[1] - origin[1]) * height[0]) / determinant,
    (width[0] * (point[1] - origin[1]) - width[1] * (point[0] - origin[0])) / determinant,
  ];
  const [alphaFrom, betaFrom] = coordinate(from);
  const [alphaTo, betaTo] = coordinate(to);
  const marginAlpha = GLYPH_BOX_TOLERANCE_MM / Math.hypot(width[0], width[1]);
  const marginBeta = GLYPH_BOX_TOLERANCE_MM / Math.hypot(height[0], height[1]);
  let range: readonly [number, number] = [0, 1];
  for (const [value0, value1, margin] of [
    [alphaFrom, alphaTo, marginAlpha],
    [betaFrom, betaTo, marginBeta],
  ] as const) {
    const clipped = clipInterval(range, value0, value1, margin, 1 - margin);
    if (clipped === undefined) return false;
    range = clipped;
  }
  return true;
}

/**
 * 线段是否穿过占位框：{@link quadCrossedBySegment} 的轴对齐形式。
 * @param box - 占位框。
 * @param from - 线段起点。
 * @param to - 线段终点。
 * @returns 穿过时 true。
 */
export function boxCrossedBySegment(
  box: GlyphBox,
  from: readonly [number, number],
  to: readonly [number, number],
): boolean {
  return quadCrossedBySegment(boxQuad(box), from, to);
}

/**
 * 引线在文字占位框上的止点：自 `from` 指向文字基线锚点，止于占位框边界 —— 引线
 * 因此不进入占位框，文字不会被线条贯穿。
 * @param content - 文字内容（决定宽度）。
 * @param baseline - 基线锚点（SVG `<text>` 的 x/y）。
 * @param fontSizeMm - 字号（毫米）。
 * @param anchor - 水平对齐方式。
 * @param from - 引线起点（零件上的指称点）。
 * @returns 引线止点；起点与文字中心重合、或起点已落在占位框内时为 undefined。
 */
export function leaderEnd(
  content: string,
  baseline: readonly [number, number],
  fontSizeMm: number,
  anchor: GlyphTextAnchor,
  from: readonly [number, number],
): readonly [number, number] | undefined {
  const box = glyphBox(content, baseline, fontSizeMm, anchor);
  const center: readonly [number, number] = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  const dx = center[0] - from[0];
  const dy = center[1] - from[1];
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return undefined;
  const unit: readonly [number, number] = [dx / distance, dy / distance];
  // 沿 -unit 自中心后退，各自先出框的那一步决定后退量。
  const stepX =
    unit[0] === 0
      ? Number.POSITIVE_INFINITY
      : (unit[0] > 0 ? center[0] - box.minX : box.maxX - center[0]) / Math.abs(unit[0]);
  const stepY =
    unit[1] === 0
      ? Number.POSITIVE_INFINITY
      : (unit[1] > 0 ? center[1] - box.minY : box.maxY - center[1]) / Math.abs(unit[1]);
  const back = Math.min(stepX, stepY);
  if (!(back < distance)) return undefined;
  return [center[0] - back * unit[0], center[1] - back * unit[1]];
}
