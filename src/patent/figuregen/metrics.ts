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
