/**
 * 归一化：只做可逆的书写形态统一，把改动限制在「同一段文字的不同写法」。
 *
 * 允许：
 * - 全角 ASCII（U+FF01–U+FF5E）→ 半角；
 * - 任意空白序列（含全角空格、换行）→ 单个半角空格；
 * - 中英文标点统一（下表）。
 *
 * 禁止：同义词替换、大小写折叠、繁简转换、去掉「的/了」等虚词。这些会让
 * 「包括」与「包含」相撞，把改写当成原文。
 *
 * 每个输出字符都带一段原文区间，命中位置可以映射回原文字节位置。
 */

import type { NormalizedText, SourceSpan } from "./types.js";

/**
 * 中英文标点对照。只收「同义书写形态」：中文顿号与逗号都作列举分隔，
 * 弯引号与直引号是同一符号的两种排印。
 */
const PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  "，": ",",
  "、": ",",
  "；": ";",
  "：": ":",
  "。": ".",
  "！": "!",
  "？": "?",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "《": "<",
  "》": ">",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "～": "~",
  "－": "-",
  "—": "-",
  "–": "-",
  "·": ".",
};

/** ASCII 空白与 Unicode 空白（`\s` 已覆盖全角空格 U+3000）。 */
function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** 判断是否为全角 ASCII 字符（含全角数字、字母与全角标点）。 */
function isFullWidthAscii(code: number): boolean {
  return code >= 0xff01 && code <= 0xff5e;
}

/** 单个字符的书写形态归一化；未收录的字符原样返回。 */
export function normalizeChar(ch: string): string {
  const code = ch.codePointAt(0);
  if (code === undefined) return ch;
  if (isFullWidthAscii(code)) return String.fromCharCode(code - 0xfee0);
  return PUNCTUATION_MAP[ch] ?? ch;
}

/**
 * 归一化并保留偏移。
 *
 * 不做首尾裁剪：前导空白保留为一个空格，命中区间仍然落在真实位置上。
 * 连续空白的来源区间覆盖整段空白，因此 `hit.start` 指向第一个空白字符。
 */
export function normalizeWithOffsets(input: string): NormalizedText {
  let text = "";
  const spans: SourceSpan[] = [];
  let index = 0;

  while (index < input.length) {
    const ch = input[index]!;

    if (isWhitespace(ch)) {
      const start = index;
      while (index < input.length && isWhitespace(input[index]!)) index += 1;
      text += " ";
      spans.push({ start, end: index });
      continue;
    }

    const normalized = normalizeChar(ch);
    text += normalized;
    // normalizeChar 的映射均为单字符；若未来引入多字符映射，这里按字符数展开。
    for (let offset = 0; offset < normalized.length; offset += 1) {
      spans.push({ start: index, end: index + 1 });
    }
    index += 1;
  }

  return { text, spans };
}

/** 只要归一化文本、不需要偏移时的便捷入口。 */
export function normalizeText(input: string): string {
  return normalizeWithOffsets(input).text;
}
