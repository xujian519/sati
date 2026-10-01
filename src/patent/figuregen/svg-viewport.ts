/**
 * SVG 根元素的视口换算（纯函数，无 IO）：把根元素声明的画布尺寸、`viewBox` 与
 * `preserveAspectRatio` 译成「用户单位 → 毫米」的映射。
 *
 * 为什么要在落版与复核之间共用：根元素的画布尺寸与用户单位不是一回事。
 * `width="210mm" viewBox="0 0 744.09 1052.36"` 里 1 用户单位只有 0.282 毫米，把 `width`
 * 的数值直接当毫米用会得到三倍半的尺寸；没有 `viewBox` 时 1 用户单位按 CSS 的 96 dpi
 * 像素算（25.4/96 毫米）；有 `viewBox` 而两侧纵横比不一致时，`preserveAspectRatio`
 * 决定内容按哪条边等比对齐（默认 `xMidYMid meet`，`slice` 取大值并裁掉超出视口的部分，
 * `none` 则两轴各自拉伸）。落版按同一映射放置图形、复核按同一映射量测图面，两处的
 * 毫米才指同一个长度。
 * @module src/patent/figuregen/svg-viewport
 */

/** 像素/英寸（未声明单位的 SVG 长度按 CSS 像素处理）。 */
const PX_PER_INCH = 96;

/** 毫米/英寸。 */
const MM_PER_INCH = 25.4;

/** 点/英寸（pt 长度单位）。 */
const PT_PER_INCH = 72;

/** 一个用户单位（无 `viewBox` 时的 CSS 像素）折算的毫米数。 */
export const MM_PER_USER_UNIT = MM_PER_INCH / PX_PER_INCH;

/** `viewBox` 原点与尺寸（用户单位）。 */
export type SvgViewBox = {
  /** viewBox 原点 X。 */
  readonly x: number;
  /** viewBox 原点 Y。 */
  readonly y: number;
  /** viewBox 宽（用户单位，正数）。 */
  readonly width: number;
  /** viewBox 高（用户单位，正数）。 */
  readonly height: number;
};

/**
 * 根元素的视口映射：`xMm = scaleX · (x - originX)`、`yMm = scaleY · (y - originY)`。
 */
export type SvgViewport = {
  /** 根元素声明的画布宽（毫米）；未声明或无法解析（如百分比）时 undefined。 */
  readonly widthMm?: number;
  /** 根元素声明的画布高（毫米）；未声明或无法解析时 undefined。 */
  readonly heightMm?: number;
  /** 换算用的视口宽（毫米）：未声明时按 viewBox 的 96 dpi 用户单位取值；两者都缺时 undefined。 */
  readonly viewportWidthMm?: number;
  /** 换算用的视口高（毫米）：未声明时按 viewBox 的 96 dpi 用户单位取值；两者都缺时 undefined。 */
  readonly viewportHeightMm?: number;
  /** viewBox 原点与尺寸；根元素未声明或声明不可解析时为 undefined。 */
  readonly viewBox?: SvgViewBox;
  /** 用户单位 → 毫米的缩放（等比映射时两值相同）。 */
  readonly scaleX: number;
  /** 用户单位 → 毫米的缩放（等比映射时两值相同）。 */
  readonly scaleY: number;
  /** 映射到视口左上角的用户单位坐标（`scaleX · (x - originX)` 即图面的毫米 X）。 */
  readonly originX: number;
  /** 映射到视口左上角的用户单位坐标。 */
  readonly originY: number;
  /** 映射只能近似、或需向使用者说明时给出原因（如两轴缩放不等、超出视口被裁）；精确时为 undefined。 */
  readonly note?: string;
};

/** 根元素属性的值（第一个匹配的 `name="…"`，属性名不区分大小写）。 */
function attribute(openTag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  return pattern.exec(openTag)?.[1];
}

/**
 * 解析 SVG 长度值为毫米（支持 mm/cm/in/pt/px 与无单位，无单位按 CSS 像素）。
 * @param raw - 长度属性原文。
 * @returns 毫米值；无法解析（含百分比、`auto` 等相对值）时 undefined。
 */
export function parseLengthMm(raw: string): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)\s*$/i.exec(raw);
  if (match === null) return undefined;
  const value = Number(match[1]);
  switch ((match[2] ?? "").toLowerCase()) {
    case "":
    case "px":
      return (value / PX_PER_INCH) * MM_PER_INCH;
    case "mm":
      return value;
    case "cm":
      return value * 10;
    case "in":
      return value * MM_PER_INCH;
    case "pt":
      return (value / PT_PER_INCH) * MM_PER_INCH;
    default:
      return undefined;
  }
}

/** `viewBox` 属性 → 原点与尺寸；顶点数与取值非法、宽或高非正时 undefined。 */
function parseViewBox(raw: string | undefined): SvgViewBox | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return undefined;
  const [x, y, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/** `preserveAspectRatio` 解析结果：两轴各自拉伸（`none`）、取小值（`meet`）或取大值（`slice`）与对齐权重。 */
type AspectRatio =
  | { readonly kind: "none" }
  | { readonly kind: "meet" | "slice"; readonly alignX: number; readonly alignY: number }
  | { readonly kind: "invalid" };

/**
 * 对齐关键字 → 视口内的对齐权重（`Min` 靠起点 0、`Mid` 居中 0.5、`Max` 靠终点 1）。
 * @param keyword - 对齐关键字的轴部分（`Min`/`Mid`/`Max`）。
 * @returns 该轴的对齐权重。
 */
function alignRatio(keyword: string): number {
  switch (keyword) {
    case "Min":
      return 0;
    case "Mid":
      return 0.5;
    default:
      return 1;
  }
}

/** `preserveAspectRatio` 属性 → 缩放方式与对齐；缺省为 `xMidYMid meet`。 */
function parseAspectRatio(raw: string | undefined): AspectRatio {
  if (raw === undefined) return { kind: "meet", alignX: 0.5, alignY: 0.5 };
  const match = /^(?:defer\s+)?(none|x(Min|Mid|Max)Y(Min|Mid|Max))(?:\s+(meet|slice))?$/.exec(raw.trim());
  if (match === null) return { kind: "invalid" };
  if (match[1] === "none") return { kind: "none" };
  return {
    kind: match[4] === "slice" ? "slice" : "meet",
    alignX: alignRatio(match[2] as string),
    alignY: alignRatio(match[3] as string),
  };
}

/**
 * 解析根元素的视口映射。
 *
 * 没有 `viewBox` 时 1 用户单位按 CSS 的 96 dpi 像素换算；有 `viewBox` 时先按声明的
 * 画布尺寸（缺失的一边按同一 96 dpi 折算）得到视口尺寸，再按 `preserveAspectRatio`
 * 决定等比缩放与对齐；两轴缩放不等（`none`）时长度量测只能取两轴的平均值，故给出
 * `note`。
 * @param openTag - 根元素（`<svg …>`）的开始标签文本。
 * @returns 视口映射。
 */
export function resolveSvgViewport(openTag: string): SvgViewport {
  const declaredWidth = attribute(openTag, "width");
  const declaredHeight = attribute(openTag, "height");
  const widthMm = declaredWidth === undefined ? undefined : parseLengthMm(declaredWidth);
  const heightMm = declaredHeight === undefined ? undefined : parseLengthMm(declaredHeight);
  const declared = {
    ...(widthMm === undefined ? {} : { widthMm }),
    ...(heightMm === undefined ? {} : { heightMm }),
  };
  const viewBox = parseViewBox(attribute(openTag, "viewBox"));
  if (viewBox === undefined) {
    const note =
      attribute(openTag, "viewBox") === undefined ? undefined : "根元素的 viewBox 无法解析，用户单位按 96 dpi 像素换算";
    return {
      ...declared,
      ...(widthMm === undefined ? {} : { viewportWidthMm: widthMm }),
      ...(heightMm === undefined ? {} : { viewportHeightMm: heightMm }),
      scaleX: MM_PER_USER_UNIT,
      scaleY: MM_PER_USER_UNIT,
      originX: 0,
      originY: 0,
      ...(note === undefined ? {} : { note }),
    };
  }
  const viewportWidthMm = widthMm ?? viewBox.width * MM_PER_USER_UNIT;
  const viewportHeightMm = heightMm ?? viewBox.height * MM_PER_USER_UNIT;
  const aspect = parseAspectRatio(attribute(openTag, "preserveAspectRatio"));
  const base = { ...declared, viewportWidthMm, viewportHeightMm, viewBox };
  if (aspect.kind === "none") {
    return {
      ...base,
      scaleX: viewportWidthMm / viewBox.width,
      scaleY: viewportHeightMm / viewBox.height,
      originX: viewBox.x,
      originY: viewBox.y,
      note: 'preserveAspectRatio="none"：两轴缩放不等，线宽按两轴缩放的几何平均换算',
    };
  }
  const scale = (aspect.kind === "slice" ? Math.max : Math.min)(
    viewportWidthMm / viewBox.width,
    viewportHeightMm / viewBox.height,
  );
  const offsetX = (viewportWidthMm - viewBox.width * scale) * (aspect.kind === "invalid" ? 0.5 : aspect.alignX);
  const offsetY = (viewportHeightMm - viewBox.height * scale) * (aspect.kind === "invalid" ? 0.5 : aspect.alignY);
  const notes = [
    ...((widthMm === undefined) !== (heightMm === undefined)
      ? ["根元素只声明了一边的画布尺寸，viewBox 的对齐偏移按 96 dpi 假设的视口计"]
      : []),
    ...(aspect.kind === "invalid" ? ["根元素的 preserveAspectRatio 无法解析，按默认 xMidYMid meet 换算"] : []),
    ...(aspect.kind === "slice" ? ['preserveAspectRatio="… slice"：超出视口的内容被裁掉，报告按越出画布处理'] : []),
  ];
  return {
    ...base,
    scaleX: scale,
    scaleY: scale,
    originX: viewBox.x - offsetX / scale,
    originY: viewBox.y - offsetY / scale,
    ...(notes.length === 0 ? {} : { note: notes.join("；") }),
  };
}
