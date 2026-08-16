/**
 * src/knowledge/legal — 长查询切词关键词提取（纯函数）。
 *
 * 从 legal-search.ts 拆出（轮次 1 纯搬移）：被 case-law-search / knowledge-law-search
 * 两个引擎跨域复用，独立成模块消除对 LegalSearchEngine 文件的 import 耦合。
 */

import { FTS_MIN_RUNES } from "../shared/fts.js";

/** 长查询切词用的虚词/疑问词（按这些词切分后取 ≥3 字片段）。 */
const SPLIT_WORDS = [
  "的",
  "是",
  "吗",
  "呢",
  "什么",
  "如何",
  "怎么",
  "是否",
  "哪些",
  "一个",
  "一种",
  "以及",
  "如果",
  "那么",
];

/**
 * 把长查询切分为 ≥3 字的关键词片段（trigram tokenizer 要求 3+ 字符）。
 * 例："专利侵权的赔偿标准是什么" → ["专利侵权", "赔偿标准"]
 */
export function extractLawKeywords(query: string, max = 4): string[] {
  let rest = query;
  for (const w of SPLIT_WORDS) {
    rest = rest.split(w).join("\n");
  }
  const fragments = rest
    .split(/\s+/)
    .map(f => f.trim())
    .filter(f => Array.from(f).length >= FTS_MIN_RUNES);
  return fragments.slice(0, max);
}
