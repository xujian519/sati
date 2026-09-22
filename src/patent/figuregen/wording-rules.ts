/**
 * src/patent/figuregen — 图面用语规则（V12/V13/V14）的纯函数实现。
 *
 * 只吃**图面词语**（节点 label 与边标签），不吃说明书正文——正文侧的括号规则已由
 * V10/V11 覆盖，重复报同一处缺陷只会制造噪音。
 *
 * 依据（逐条溯源见 skills/patent-illustrator/references/*-drawing-rules.md）：
 * - V12 非必需注释：细则第 21 条第 3 款「附图中除必需的词语外，不应当含有其他注释」+
 *   指南一部一章 4.3；其中比例/尺寸标注另有域外明文（PCT 申请人指南 IP 5.150 对 Rule
 *   11.13(c) 的释义「Indications such as actual size or scale ½ on the drawings … are not
 *   permitted」、37 CFR 1.84(k)「Indications such as "actual size" or "scale 1/2" on the
 *   drawings are not permitted」，均已核官方原文。⚠️ 不要引 Rule 11.13(d)——该款只说"比例
 *   若给出须用图形表示"，并未禁止尺寸标注）
 * - V13 图面用语非中文（**仅 cn**）：指南一部一章 4.3「附图中的词语应当使用中文，必要时
 *   可以在其后的括号里注明原文」
 * - V14 标号形态：指南一部一章 4.3「附图标记应当使用阿拉伯数字编号」；数字与括号/引号/
 *   圈号连用另有域外明文（PCT Rule 11.13(e)、37 CFR 1.84(p)(1)「must not be used in
 *   association with brackets or inverted commas, or enclosed within outlines, e.g.,
 *   encircled」，已核 eCFR 原文）
 *
 * 有意不判的三类（防误伤，逐条在代码处注明）：
 * 1. `S101` 式方法步骤标号（字母前缀 + 数字）——不是附图标记（不承载 ref），且
 *    `cn-drawing-rules.md` §3 把「S100、S110」登记为方法步骤的既有代理惯例，对每个流程图
 *    报一遍只会淹没真缺陷；
 * 2. 大写字母后缀（`20A`）——US 侧 37 CFR 1.84(u)(1) 与 PCT 指南 IP 5.141 都明文允许「same
 *    number followed by a capital letter」（部分视图，如 Fig. 7B），判它会与两法域明文冲突；
 * 3. 量纲/技术词（`24V`、`3D`、`5G`）——与标号同形，无上下文无法可靠区分。
 */

import type { FigureSpec, Jurisdiction } from "./types.js";

/** 发现级别（与 check.ts 的 FigureCheckSeverity 结构兼容；本模块不反向导入，避免环）。 */
export type WordingSeverity = "warn" | "info";

export type WordingRuleId = "V12" | "V13" | "V14";

export type WordingIssueKind =
  | "annotation-prefix"
  | "body-reference"
  | "dimension-annotation"
  | "scale-annotation"
  | "terminal-punctuation"
  | "figure-number-in-drawing"
  | "non-chinese-wording"
  | "numeral-with-letter-affix"
  | "numeral-in-brackets";

/**
 * 适用法域：
 * - `all`：条文在 CN 与域外同构（注释、图号入图、标号带字母后缀）；
 * - `cn`：只见于中文指南的要求（图面词语用中文）；
 * - `non-cn`：只见于域外明文（比例/尺寸标注禁令、"数字不得与括号/引号/圈号连用"）。
 */
export type WordingScope = "all" | "cn" | "non-cn";

export type WordingKindSpec = {
  readonly rule: WordingRuleId;
  readonly scope: WordingScope;
  readonly severity: WordingSeverity;
  /** 证据行中对这一类的说明（"图N 节点「x」: 含尺寸标注「20mm」"）。 */
  readonly describe: string;
};

export const WORDING_KIND_SPEC: Record<WordingIssueKind, WordingKindSpec> = {
  "annotation-prefix": { rule: "V12", scope: "all", severity: "warn", describe: "以注释前缀开头" },
  "body-reference": { rule: "V12", scope: "all", severity: "warn", describe: "含正文引用式表述" },
  "dimension-annotation": { rule: "V12", scope: "all", severity: "warn", describe: "含尺寸标注" },
  "scale-annotation": { rule: "V12", scope: "non-cn", severity: "warn", describe: "含比例/缩放标注" },
  "terminal-punctuation": { rule: "V12", scope: "all", severity: "warn", describe: "以句末标点结尾" },
  "figure-number-in-drawing": { rule: "V12", scope: "all", severity: "warn", describe: "图面出现图号字样" },
  "non-chinese-wording": { rule: "V13", scope: "cn", severity: "warn", describe: "图面词语非中文" },
  "numeral-with-letter-affix": { rule: "V14", scope: "all", severity: "warn", describe: "标号带（小写）字母后缀" },
  "numeral-in-brackets": {
    rule: "V14",
    scope: "non-cn",
    severity: "warn",
    describe: "标号与括号/引号/圈号连用",
  },
};

export type WordingIssue = { readonly kind: WordingIssueKind; readonly text: string };

const ANNOTATION_PREFIX = /^[ \t\u3000]*(?:注|注意|说明|备注|提示)[ \t\u3000]*[:：]/u;
const BODY_REFERENCE = /(?:如图|如附图|见图|参见图|参见附图|见附图|详见附图|参照图|结合图)/u;
/** 尺寸标注：数字 + 长度单位（拉丁单位后不得再接字母，避免把 `100ms`、`24V` 判成尺寸）。 */
const DIMENSION_ANNOTATION =
  /\d+(?:[.,]\d+)?[ \t]*(?:mm|cm|dm|km|µm|μm|um|nm|inch(?:es)?|m)(?![A-Za-z])|\d+(?:[.,]\d+)?[ \t]*(?:毫米|厘米|微米|纳米|英寸|米)/u;
const SCALE_KEYWORD = /(?:比例尺?|缩放比?|放大|缩小|scale)/iu;
const SCALE_RATIO = /\d{1,3}[ \t]*[:：][ \t]*\d{1,3}(?!\d)/u;
const TERMINAL_PUNCTUATION = /[。；;][ \t\u3000]*$/u;
const FIGURE_NUMBER_IN_DRAWING = /(?:(?<![A-Za-z])(?:FIG|Fig)\.?[ \t]*\d+)|(?:图[ \t]*\d+)/u;
/** 标号带小写字母后缀（`20a`）：大写形态在 US 是部分视图的合法写法，故只判小写。 */
const NUMERAL_WITH_LETTER_AFFIX = /(?<![A-Za-z0-9])\d{2,}[a-z](?![A-Za-z0-9])/u;
const BRACKET_NUMERAL = /[（(][ \t]*(\d{1,3})[ \t]*[)）]/gu;
const QUOTED_NUMERAL = /[「『“"‘'][ \t]*(\d{1,3})[ \t]*[」』”"’']/gu;
const CIRCLED_NUMERAL = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/gu;
/** 括号/引号连用的排除前缀（公式/步骤/图号类编号，与 V11 的分面排除同源）。 */
const NON_REFERENCE_BEFORE = /(?:式|公式|步骤|条款|第|图|表|claim|step|formula|fig)s?[ \t]*$/iu;

/** 计量单位符号白名单：全小写但属"必要时可用的原文符号"，不判非中文。 */
const UNIT_SYMBOLS = new Set([
  "mm",
  "cm",
  "dm",
  "km",
  "um",
  "nm",
  "m",
  "kg",
  "g",
  "mg",
  "ml",
  "l",
  "s",
  "ms",
  "min",
  "h",
  "hz",
  "khz",
  "mhz",
  "v",
  "mv",
  "kv",
  "a",
  "ma",
  "w",
  "kw",
  "mw",
  "pa",
  "kpa",
  "mpa",
  "n",
  "kn",
  "ohm",
  "j",
  "kj",
  "c",
  "k",
  "f",
]);

function scopeAllows(scope: WordingScope, jurisdiction: Jurisdiction): boolean {
  if (scope === "all") return true;
  if (scope === "cn") return jurisdiction === "cn";
  return jurisdiction !== "cn";
}

/**
 * 非中文词语识别：先剔除括号内内容（4.3 明文允许「在其后的括号里注明原文」），再逐个
 * 拉丁词元判断——无小写字母者放行（CPU/I2C/A-D 等全大写缩写），计量单位符号放行。
 */
function findNonChineseWording(text: string): string[] {
  const withoutParenthetical = text.replaceAll(/[（(][^（()）]*[)）]/gu, " ");
  const tokens = withoutParenthetical.match(/[A-Za-z][A-Za-z0-9'’\-/_.]*/gu) ?? [];
  const hits = new Set<string>();
  for (const token of tokens) {
    if (!/[a-z]/u.test(token)) continue;
    if (UNIT_SYMBOLS.has(token.toLowerCase())) continue;
    hits.add(token);
  }
  return [...hits];
}

/** 数字与括号/引号/圈号连用（排除 式(1)/步骤(1)/图(1) 类编号）。 */
function findBracketNumerals(text: string): string[] {
  const hits = new Set<string>();
  for (const match of text.matchAll(BRACKET_NUMERAL)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 3), match.index ?? 0);
    if (NON_REFERENCE_BEFORE.test(before)) continue;
    hits.add(match[0]);
  }
  for (const match of text.matchAll(QUOTED_NUMERAL)) {
    hits.add(match[0]);
  }
  for (const match of text.matchAll(CIRCLED_NUMERAL)) {
    hits.add(match[0]);
  }
  return [...hits];
}

/** 截断用于证据行的片段（图面词语可能很长，证据只需可定位）。 */
function clip(text: string): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > 32 ? `${flat.slice(0, 32)}…` : flat;
}

/** 扫描单段图面词语，返回该法域下适用的用语发现。 */
export function inspectWording(text: string, jurisdiction: Jurisdiction = "cn"): WordingIssue[] {
  const issues: WordingIssue[] = [];
  const push = (kind: WordingIssueKind, matched: string): void => {
    if (scopeAllows(WORDING_KIND_SPEC[kind].scope, jurisdiction)) issues.push({ kind, text: clip(matched) });
  };

  const lines = text.split("\n");
  for (const line of lines) {
    const prefix = ANNOTATION_PREFIX.exec(line);
    if (prefix) push("annotation-prefix", line);
    if (TERMINAL_PUNCTUATION.test(line)) push("terminal-punctuation", line);
  }

  const bodyReference = BODY_REFERENCE.exec(text);
  if (bodyReference) push("body-reference", bodyReference[0]);

  const dimension = DIMENSION_ANNOTATION.exec(text);
  if (dimension) push("dimension-annotation", dimension[0]);

  const scale = SCALE_KEYWORD.exec(text) ?? SCALE_RATIO.exec(text);
  if (scale) push("scale-annotation", scale[0]);

  const figureNumber = FIGURE_NUMBER_IN_DRAWING.exec(text);
  if (figureNumber) push("figure-number-in-drawing", figureNumber[0]);

  for (const token of findNonChineseWording(text)) push("non-chinese-wording", token);

  const affix = NUMERAL_WITH_LETTER_AFFIX.exec(text);
  if (affix) push("numeral-with-letter-affix", affix[0]);

  for (const bracket of findBracketNumerals(text)) push("numeral-in-brackets", bracket);

  return issues;
}

/** 单条图面用语命中（已解析到规则/级别/位置，供 check.ts 直接聚合成 finding）。 */
export type WordingHit = {
  readonly rule: WordingRuleId;
  readonly severity: WordingSeverity;
  readonly kind: WordingIssueKind;
  readonly describe: string;
  readonly figure_no: number;
  /** 命中位置（节点/边），供证据行拼装。 */
  readonly where: string;
  readonly text: string;
};

/** 扫描全部附图的图面词语（节点 label + 边标签）。 */
export function scanFigureWording(figures: readonly FigureSpec[], jurisdiction: Jurisdiction = "cn"): WordingHit[] {
  const hits: WordingHit[] = [];
  const collect = (figureNo: number, where: string, text: string): void => {
    for (const issue of inspectWording(text, jurisdiction)) {
      const spec = WORDING_KIND_SPEC[issue.kind];
      hits.push({
        rule: spec.rule,
        severity: spec.severity,
        kind: issue.kind,
        describe: spec.describe,
        figure_no: figureNo,
        where,
        text: issue.text,
      });
    }
  };
  for (const figure of figures) {
    for (const node of figure.nodes) collect(figure.figure_no, `节点「${node.id}」`, node.label);
    for (const edge of figure.edges) {
      if (edge.label !== undefined) collect(figure.figure_no, `边「${edge.from}→${edge.to}」`, edge.label);
    }
  }
  return hits;
}
