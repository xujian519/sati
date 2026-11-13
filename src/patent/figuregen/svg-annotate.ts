/**
 * src/patent/figuregen — 既有 SVG 的附图参考标号追加与登记核对（纯函数、无 IO）。
 *
 * 用途：给**已经画好**的 SVG 追加附图参考标号（图元文本已在，但图元上没有标记），并核对
 * 图面上已出现的标记是否都在案卷登记的标记集合内。两个动作读的是同一份"图面文本"，因此
 * 共用同一套文本抽取（去标签 + 解实体）与同一道安全门。
 *
 * 依据：
 * - 标记书写形态：本仓惯例是「处理模块(20)」——名称 + 半角括号 + 阿拉伯数字（见
 *   `types.ts` 的 FigureNode.label 说明，以及 `check-context.ts` 的 `stripRefMark` /
 *   `normalizeRefLabel` 词法）。故追加形态是 `(${numeral})`，**不带空格**。
 * - 标记取值边界与编号词排除：复用 `numeral.ts`（`isRefNumeral` /
 *   `REF_NUMERAL_PRACTICAL_MAX` / `hasNumeralPrefix`），使"图面上的数字是不是附图标记"
 *   在核验侧（V2/V3 双向核验）与本抽取侧是同一套词法——细则第 21 条要求附图标记与
 *   说明书文字部分双向一致，两侧各写一套词法会让同一条文本得到不同答案。
 * - 安全门：复用 `svg-safety.ts` 的 `assertSafeSvg`（大小上限 + 拒 DOCTYPE/ENTITY/CDATA
 *   + 需 `<svg` 根）。本模块的输入可能来自跨信任边界的读盘，失败即抛 `SvgSafetyError`
 *   （不吞掉、不转成别的错误类型），由调用方决定如何呈现。
 *
 * 与 DSH（`packages/patent/patent-tools/src/figure/svg-annotate.ts`）的差异：
 * 1. 追加形态：DSH 追加「 (n)」（带空格），本仓追加「(n)」（无空格）——本仓惯例是
 *    「处理模块(20)」，与 `stripRefMark` / `normalizeRefLabel` 的词法一致。
 * 2. 安全门：DSH 自带 `assertSafeSvg`（连同大小上限与 ENTITY/CDATA 拒绝）；本仓复用
 *    `svg-safety.ts` 的同名门，失败抛 `SvgSafetyError`。
 * 3. 未命中的返回形态：DSH 返回 label 字符串数组；本仓返回结构化的 `{text, numeral}`
 *    清单，且 `applied`（命中请求数）与 `unmatched` 互补：
 *    `applied + unmatched.length === requests.length`——未命中**不静默丢弃**。
 * 4. 匹配语义沿用 DSH：同一个请求可命中多个 `<text>` 图元（同一组成部分在图内多处出现
 *    时同号标注，专利制图惯例），但**每个图元至多被一个请求命中一次**（先命中先得：
 *    同一图元上多个请求都匹配时取请求数组中靠前者）。
 *
 * 本批边界（下一批再做，本模块**不**越界）：
 * - **不新增 builtin 工具**：新增工具会改变工具列表，使 llm-replay 的 requestKey
 *   （含 toolSchemaDigest）失配、既有 fixture 必须重录（AGENTS.md 第 6 条）。工具层
 *   接线（工具名、`inputSchema`、输出契约、错误码映射）留待下一批。
 * - **不改 barrel**：`figuregen/index.ts` 的导出由主代理统一添加。
 * - 不做 XML 解析（轻量正则）：图元内含嵌套标签时，插入点取"最后一个子元素闭合标签
 *   之前"，无子元素时取 `</text>` 之前。
 */

import { hasNumeralPrefix, isRefNumeral, REF_NUMERAL_PRACTICAL_MAX } from "./numeral.js";
import { assertSafeSvg } from "./svg-safety.js";

/** 一条参考标号请求：在图元文本上匹配 `text`，命中后追加 `numeral`。 */
export type SvgReferenceRequest = {
  /** 目标图元上的文字（子串匹配，大小写不敏感）。 */
  readonly text: string;
  /** 附图标记（阿拉伯数字；须为正整数，判据见 `numeral.ts` 的 `isRefNumeral`）。 */
  readonly numeral: number;
};

/** 未命中的请求（原样回传，便于调用方定位是哪一个标号没落上）。 */
export type SvgUnmatchedReference = {
  readonly text: string;
  readonly numeral: number;
};

/** 标注结果：追加后的 SVG + 命中请求数 + 未命中清单。 */
export type SvgAnnotateResult = {
  /** 追加标号后的 SVG 文本（只改 `<text>` 内容，其余原样保留）。 */
  readonly svg: string;
  /** 已命中的请求数（与 `unmatched` 互补：两者之和 === 请求总数）。 */
  readonly applied: number;
  /** 未命中任何图元的请求（按传入顺序）。 */
  readonly unmatched: readonly SvgUnmatchedReference[];
};

/** 未登记标记的核对结果。 */
export type SvgReferenceValidation = {
  /** 图面上出现、但不在 `known` 里的附图标记（去重升序）。 */
  readonly unknown: readonly number[];
};

/** `<text>` 图元：内容区间 + 可见文本（去标签、解实体后的可读文本）。 */
type TextElement = {
  /** 内容在原 SVG 中的起始下标。 */
  readonly contentStart: number;
  /** 原始内容（可能含嵌套标签）。 */
  readonly content: string;
  /** 可见文本（匹配与"已含标号"判定都用它）。 */
  readonly visible: string;
};

/**
 * `<text>` 图元的抽取正则。
 *
 * 属性部分容忍引号内的 `>`（`font-family="a>b"` 这类写法会让朴素的 `[^>]*` 提前截断，
 * 从而把属性尾巴误当正文）；`\b` 保证 `<textPath>` 之类不被误当 `<text>`。
 */
const TEXT_ELEMENT_PATTERN = /<text\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/text\s*>/giu;

/** 子元素闭合标签（用于定位插入点：追加到最后一个子元素内部）。 */
const CHILD_CLOSE_PATTERN = /<\/[A-Za-z][^>]*>/gu;

/** 图面上的附图标记形态：半角/全角括号 + 数字（与 `stripRefMark` 同一词法）。 */
const REF_MARK_PATTERN = /[（(]\s*(\d+)\s*[)）]/gu;

/** 解码文本节点中常见的 XML 实体（仅用于匹配比较，输出保持原文）。 */
function decodeXmlEntities(text: string): string {
  // 数字实体与命名实体顺序照 `readback.ts` 的 `unescapeXml`：&amp; 最后展开，
  // 保证字面量 "&#45;" 只被解码一层。
  return text
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/** 移除 XML 标签（提取文本内容做匹配比较）。 */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/gu, "");
}

/** 图元可见文本：去标签 + 解实体。 */
function visibleText(content: string): string {
  return decodeXmlEntities(stripTags(content));
}

/** 抽取 SVG 中全部 `<text>` 图元（按文档顺序）。 */
function collectTextElements(svg: string): TextElement[] {
  const elements: TextElement[] = [];
  for (const match of svg.matchAll(TEXT_ELEMENT_PATTERN)) {
    const whole = match[0];
    const content = match[2];
    // 内容起点 = 闭合标签起点 - 内容长度（闭合标签位置由 lastIndexOf 取，避开属性里的 "</"）。
    const closeIndex = whole.lastIndexOf("</");
    const contentStart = (match.index ?? 0) + closeIndex - content.length;
    elements.push({
      contentStart,
      content,
      visible: visibleText(content),
    });
  }
  return elements;
}

/**
 * 追加位置（相对内容起点）：有子元素时落在**最后一个子元素内部**（`</tspan>` 之前），
 * 否则落在内容末尾（`</text>` 之前）。
 */
function insertOffsetInContent(content: string): number {
  let last = -1;
  for (const match of content.matchAll(CHILD_CLOSE_PATTERN)) {
    last = match.index ?? last;
  }
  return last >= 0 ? last : content.length;
}

/** 图元可见文本里是否已带该标记（括号形态；裸数字形态属说明书正文惯例，不算图面已标注）。 */
function containsRefMark(visible: string, numeral: number): boolean {
  const pattern = new RegExp(`[（(]\\s*${numeral}\\s*[)）]`, "u");
  return pattern.test(visible);
}

/** 请求是否可用：文本非空 + 标记为正整数（否则不参与匹配，计入未命中）。 */
function isUsableRequest(request: SvgReferenceRequest): boolean {
  return request.text.trim() !== "" && isRefNumeral(request.numeral);
}

/**
 * 给既有 SVG 追加附图参考标号。
 *
 * 匹配：子串、大小写不敏感（对图元的**可见文本**匹配，故嵌套标签不影响匹配）。
 * 每个 `<text>` 图元至多被一个请求命中一次（先命中先得：同一图元上多个请求都匹配时，
 * 取请求数组中靠前者）；同一请求可命中多个图元（同一组成部分在图内多处出现时同号标注）。
 *
 * 追加前先检查该图元是否已带该标号（已带则跳过，不重复追加）。追加形态为 `(${numeral})`
 * （本仓惯例，无空格）。
 *
 * @param svg - 既有 SVG 文本（须先过安全门）。
 * @param requests - 参考标号请求（按数组顺序参与"先命中先得"的判定）。
 * @returns 追加后的 SVG、命中请求数与未命中清单。
 * @throws SvgSafetyError 输入未通过安全门（DOCTYPE/ENTITY/CDATA、超限、缺 `<svg` 根）。
 */
export function annotateSvgWithReferences(svg: string, requests: readonly SvgReferenceRequest[]): SvgAnnotateResult {
  assertSafeSvg(svg);

  const elements = collectTextElements(svg);
  /** 命中过图元的请求下标（同一请求可命中多个图元，故用集合而非计数）。 */
  const hitRequests = new Set<number>();
  /** 待插入的追加片段（绝对下标 + 文本），最后按位置回插。 */
  const insertions: { at: number; text: string }[] = [];

  for (const element of elements) {
    const lowerVisible = element.visible.toLowerCase();
    for (const [index, request] of requests.entries()) {
      if (!isUsableRequest(request)) continue;
      // 子串匹配，大小写不敏感（可见文本已是解实体后的可读文本）。
      if (!lowerVisible.includes(request.text.trim().toLowerCase())) continue;
      // 该图元归此请求：先命中先得，后续请求不再匹配这个图元。
      hitRequests.add(index);
      // 已带该标号则不重复追加（重复追加会得到「处理模块(20)(20)」）。
      if (containsRefMark(element.visible, request.numeral)) break;
      insertions.push({
        at: element.contentStart + insertOffsetInContent(element.content),
        text: `(${request.numeral})`,
      });
      break;
    }
  }

  // 按位置回插（同一图元至多一处插入，位置互不重叠）。
  let result = "";
  let cursor = 0;
  for (const insertion of insertions.sort((a, b) => a.at - b.at)) {
    result += svg.slice(cursor, insertion.at) + insertion.text;
    cursor = insertion.at;
  }
  result += svg.slice(cursor);

  const unmatched = requests
    .map((request, index) => ({ request, index }))
    .filter(({ index }) => !hitRequests.has(index))
    .map(({ request }) => ({ text: request.text, numeral: request.numeral }));

  return { svg: result, applied: hitRequests.size, unmatched };
}

/**
 * 核对图面上出现的附图标记是否都在登记集合内。
 *
 * 扫描范围是图元的**可见文本**（不是整份 SVG 源码）：属性、路径数据里的数字不是图面内容。
 * 形态口径与本仓图面惯例一致——括号形态 `名称(20)`（`stripRefMark` 同一词法）；正文惯例的
 * 裸数字形态（`名称20`）不属图面标记，故不计入。
 *
 * 词法排除与取值边界复用 `numeral.ts`：`式(1)` / `步骤(20)` / `图(1)` 这类编号词前缀不是
 * 附图标记；超过 {@link REF_NUMERAL_PRACTICAL_MAX}（三位数实务上限）的数字更可能是年份/页码/
 * 段号，同样不计入附图标记形态。
 *
 * @param svg - 既有 SVG 文本（须先过安全门）。
 * @param known - 已登记的附图标记集合（如 FigureSpec 中各节点的 `ref`）。
 * @returns 图面上出现但未登记的标记（去重升序）。
 * @throws SvgSafetyError 输入未通过安全门。
 */
export function validateSvgReferences(svg: string, known: readonly number[]): SvgReferenceValidation {
  assertSafeSvg(svg);

  const knownSet = new Set(known);
  const found = new Set<number>();
  for (const element of collectTextElements(svg)) {
    for (const match of element.visible.matchAll(REF_MARK_PATTERN)) {
      const value = Number(match[1]);
      if (!isRefNumeral(value)) continue;
      if (value > REF_NUMERAL_PRACTICAL_MAX) continue;
      // 编号词前缀（图(1)/式(1)/步骤(20)…）不是附图标记。
      if (hasNumeralPrefix(element.visible.slice(0, match.index ?? 0))) continue;
      found.add(value);
    }
  }
  const unknown = [...found].filter(value => !knownSet.has(value)).sort((a, b) => a - b);
  return { unknown };
}
