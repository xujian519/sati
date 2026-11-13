/**
 * src/patent/figuregen — 附图标记的**词法**判定（纯函数，无依赖）。
 *
 * 为什么单独成模块（而不是留在 `check-context.ts`）：本模块被 `numeral-assign.ts` 用，
 * 而 `numeral-assign.ts` 又被三个新渲染器（时序图/电路图/多面板）用，后者被
 * `render-svg.ts` 用，`render-svg.ts` 被 `check-context.ts` 用（为新图型算画幅）
 * ⇒ 若词法留在 `check-context.ts`，这六者会成**init-time 循环依赖**
 * （`check:runtime-cycles` 门禁会红）。把词法下沉到零依赖模块即断环。
 */

/** 剥离 label 中的括号标记后缀，得到组件名称主干。 */
export function stripRefMark(label: string): string {
  return label
    .replace(/[（(]\s*(\d{1,3})\s*[)）]/gu, "")
    .split("\n")[0]
    .trim();
}

/**
 * 附图标记名称归一化（**仅用于比较**，不改变呈现形态）。
 *
 * 同一组件在图上可能写作「处理模块(20)」（附图惯例）或「处理模块20」（说明书正文
 * 惯例：名称+数字、不加括号）——两者指同一组成部分，V4 不得判为名称不一致。
 * 归一化 = 剥括号标记 + 剥尾部裸数字 + trim；`stripRefMark` 保持对外呈现形态
 * （brief.ts 依赖其输出格式）。
 */
export function normalizeRefLabel(label: string): string {
  return stripRefMark(label)
    .replace(/\s*\d{1,3}\s*$/u, "")
    .trim();
}
