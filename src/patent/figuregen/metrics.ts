/**
 * src/patent/figuregen — 文字度量（布局盒宽与打印字高的共同基准）。
 *
 * 确定性纪律：不读字体文件、不做 canvas 测量——按字符类别累计字宽
 * （CJK/全角 = 1em，Latin/数字/半角标点 = 0.5em），同一输入永远得到同一盒宽。
 * 字号常量放本模块：布局器（盒宽）与渲染器（font-size）都需要它，放在任一侧都会
 * 让两者互相 import 成环。
 */

/** 节点文字字号（px）：布局盒宽、渲染 font-size 与打印字高判据的共同基准。 */
export const FIGURE_FONT_SIZE = 14;

/**
 * 部署级字号环境变量（毫米，纸面）。
 *
 * 合规判据是**纸面字高**（毫米），而三条渲染通路各用不同单位：内置渲染器 px、Graphviz
 * pt、CAD 标号 mm。只给一个毫米值再折算到各通路，比让调用方分别设三个数字更不容易漂移。
 * 未设定时各通路沿用既有缺省，输出逐字节不变。
 */
export const FIGURE_FONT_MM_ENV = "SATI_FIGURE_FONT_MM";

/** 边标签字号与主字号之比：内置 12/14、DOT 12/14，缺省输出因此与既有快照一致。 */
export const EDGE_FONT_RATIO = 12 / 14;

/** CSS px ↔ 毫米：1in = 96px = 25.4mm（CSS 定义常量；本模块不 import page-contract，避免成环）。 */
const MM_PER_CSS_PX = 25.4 / 96;
/** 毫米 → pt：1in = 25.4mm = 72pt。 */
const PT_PER_MM = 72 / 25.4;

/**
 * 部署级字号（毫米）；未设定、空串或非法（非正有限数）时 undefined。
 * @param env - 环境变量表（缺省 process.env；测试注入用）。
 */
export function figureFontMm(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[FIGURE_FONT_MM_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 主字号（px）：未设 env 时 {@link FIGURE_FONT_SIZE}，否则由毫米折算（一位小数）。 */
export function figureFontSizePx(env: NodeJS.ProcessEnv = process.env): number {
  const mm = figureFontMm(env);
  if (mm === undefined) return FIGURE_FONT_SIZE;
  return Math.round((mm / MM_PER_CSS_PX) * 10) / 10;
}

/** 主字号（pt）：未设 env 时 14pt（Graphviz 缺省），否则由毫米折算（一位小数）。 */
export function figureFontPt(env: NodeJS.ProcessEnv = process.env): number {
  const mm = figureFontMm(env);
  if (mm === undefined) return 14;
  return Math.round(mm * PT_PER_MM * 10) / 10;
}

/** 边标签字号（px）：主字号按 {@link EDGE_FONT_RATIO} 折算（一位小数）。 */
export function edgeFontSizePx(mainPx: number): number {
  return Math.round(mainPx * EDGE_FONT_RATIO * 10) / 10;
}

/** 边标签字号（pt）：主字号按 {@link EDGE_FONT_RATIO} 折算（一位小数）。 */
export function edgeFontPt(mainPt: number): number {
  return Math.round(mainPt * EDGE_FONT_RATIO * 10) / 10;
}

/** 宽字符（按 1em 计）的码点区间：CJK 汉字/假名/谚文/全角标点与全角形式。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首补充、康熙部首、CJK 符号与标点
  [0x3041, 0x33ff], // 平假名/片假名/注音/兼容字符
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe6f], // CJK 兼容形式、小写变体
  [0xff00, 0xff60], // 全角 ASCII 与半角片假名
  [0xffe0, 0xffe6], // 全角符号
];

/** 是否宽字符（CJK/全角）：按码点判区间，代理对字符一并覆盖。 */
export function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * 文本渲染宽度（px）：CJK/全角 1em、其余 0.5em。
 *
 * 用单一字符宽度常数（旧实现 `longest * 15`）会把 Latin 标签估宽约 2 倍
 * （实测 "Data processing module" 盒宽 362 vs 中文 6 字 122），虚胖的画布还会
 * 反向推高 V7 的纸面尺寸判定。
 */
export function measureTextWidth(text: string, fontSize: number = FIGURE_FONT_SIZE): number {
  let width = 0;
  for (const char of text) {
    width += isWideChar(char) ? fontSize : fontSize / 2;
  }
  return width;
}
