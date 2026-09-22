/**
 * src/patent/figuregen — 跨信任边界的 SVG 读取安全门。
 *
 * 为什么需要：`patent_figure_check` 的 `svg_paths` 分支与 `figure-gate` 的漂移检测都会直接
 * 读盘**外部** SVG 后交给正则解析器（`readback.ts`）。解析器只承诺"只解析本模块两类渲染器
 * 的输出"这一结构契约，不做安全过滤——而 DOCTYPE/ENTITY 声明与 CDATA 段本模块渲染器根本
 * 不会产出，一旦出现即为注入；读取侧的大小上限也让"超大文件卡死处理链"成为可控失败。
 *
 * 契约：**调用方在把外部 SVG 文本交给 `parseFigureSvg` 之前必须先过 `assertSafeSvg`**。
 * 放在调用方而非解析器内部：解析器只承担"解析"一个职责，安全边界属于"这一次读盘是否跨了
 * 信任边界"的调用点事实（自产出的 SVG 走 `render-graphviz` 内部自检，无需重复扫描）。
 */

export const DEFAULT_SVG_MAX_BYTES = 2_000_000;

export type SvgSafetyErrorCode = "unsafe_svg" | "too_large" | "missing_svg_root";

export class SvgSafetyError extends Error {
  readonly code: SvgSafetyErrorCode;

  constructor(code: SvgSafetyErrorCode, message: string) {
    super(message);
    this.name = "SvgSafetyError";
    this.code = code;
  }
}

/** 本模块两类渲染器都不会产出的声明（大小写不敏感）。 */
const FORBIDDEN_MARKERS: readonly { readonly pattern: RegExp; readonly marker: string }[] = [
  { pattern: /<!doctype/iu, marker: "DOCTYPE 声明" },
  { pattern: /<!entity/iu, marker: "ENTITY 声明" },
  { pattern: /<!\[cdata\[/iu, marker: "CDATA 段" },
];

/** `<svg` 根元素（容忍命名空间前缀写法 `<svg:svg`）。 */
const SVG_ROOT = /<svg[\s:>]/iu;

export function isSvgSafetyError(value: unknown): value is SvgSafetyError {
  return value instanceof SvgSafetyError;
}

/**
 * 校验外部 SVG 文本可否进入解析链，不通过即抛 `SvgSafetyError`（不返回布尔——
 * 调用方需要错误码来选择报告措辞，返回布尔会诱使调用方静默丢弃）。
 */
export function assertSafeSvg(text: string, maxBytes: number = DEFAULT_SVG_MAX_BYTES): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new SvgSafetyError("too_large", `SVG 大小 ${bytes} 字节超出上限 ${maxBytes} 字节`);
  }
  for (const { pattern, marker } of FORBIDDEN_MARKERS) {
    if (pattern.test(text)) {
      throw new SvgSafetyError("unsafe_svg", `SVG 含${marker}（本模块渲染器不会产出，疑似外部注入）`);
    }
  }
  if (!SVG_ROOT.test(text)) {
    throw new SvgSafetyError("missing_svg_root", "SVG 缺少 <svg 根元素");
  }
}
