/**
 * FTS5（全文检索）共享工具。
 *
 * 供基于 SQLite 的知识检索引擎（legal-search / case-law-search）共用：
 * - FTS_MIN_RUNES：trigram tokenizer 要求 3+ 字符才能 MATCH（短查询需降级 LIKE）
 * - sqliteHasFts5：运行时 SQLite 是否编译了 FTS5（编译选项探测）
 *
 * 背景：桌面端捆绑的旧版 Node（node:sqlite 未编译 FTS5，如 v22.14.0）即便数据库
 * 含 FTS 表，MATCH 查询也会抛 "no such module: fts5"，必须探测后降级。
 */

import type { DatabaseSync } from "node:sqlite";

/** trigram tokenizer 要求 3+ 字符才能 MATCH。 */
export const FTS_MIN_RUNES = 3;

/** 当前运行时的 SQLite 是否编译了 FTS5（编译选项探测；探测失败按未编译处理）。 */
export function sqliteHasFts5(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number };
    return row.v === 1;
  } catch {
    // 编译选项探测失败 → 按未编译 FTS5 处理（后续降级 LIKE）。
    return false;
  }
}

/** 转义 FTS5 phrase 中的双引号，并包裹成双引号 phrase。 */
export function escapeFtsPhrase(phrase: string): string {
  return `"${phrase.replace(/"/g, '""')}"`;
}

/** 把多个词条构建为 FTS5 OR 查询表达式。 */
export function joinFtsOrTerms(terms: string[]): string {
  return terms.map(escapeFtsPhrase).join(" OR ");
}

export type FtsThenLikeOptions<T> = {
  /** 本次查询是否可尝试 FTS（已考虑 FTS 表存在性 + 运行时支持 + 未降级）。 */
  useFts: boolean;
  /** 小于该字符数的查询直接走 LIKE。 */
  minRunes: number;
  keyword: string;
  limit: number;
  searchFts: (keyword: string, limit: number) => T[];
  searchFtsKeywords: (keywords: string[], limit: number) => T[];
  searchLike: (keyword: string, limit: number) => T[];
  extractKeywords: (keyword: string) => string[];
  /** FTS 查询抛异常时回调（用于标记/记录降级），随后整体走 LIKE。 */
  onDegrade?: (message: string) => void;
};

/**
 * 统一的「FTS5 BM25 优先 → 切词 OR → LIKE 降级」编排。
 * 抽取自 legal-search / knowledge-law-search / case-law-search 三个检索引擎
 * 逐字重复的 search 主体，避免改一处漏另两处。策略以闭包传入（各引擎的
 * searchFts/searchLike 与降级打点不同），返回中间行供调用方自行 map 成结果。
 */
export function runFtsThenLikeFallback<T>(opts: FtsThenLikeOptions<T>): T[] {
  const trimmed = opts.keyword.trim();
  if (!trimmed) return [];

  const shortQuery = Array.from(trimmed).length < opts.minRunes;
  if (!opts.useFts || shortQuery) {
    return opts.searchLike(trimmed, opts.limit);
  }

  try {
    let rows = opts.searchFts(trimmed, opts.limit);
    // 整句无命中时切词 OR 查询（长句/自然语言查询）
    if (rows.length === 0) {
      const keywords = opts.extractKeywords(trimmed);
      if (keywords.length > 0 && keywords[0] !== trimmed) {
        rows = opts.searchFtsKeywords(keywords, opts.limit);
      }
    }
    // FTS 仍无命中时降级 LIKE
    if (rows.length === 0) {
      rows = opts.searchLike(trimmed, opts.limit);
    }
    return rows;
  } catch (error) {
    // FTS5 模块缺失或查询异常（如运行时 SQLite 未编译 FTS5，MATCH 抛
    // "no such module: fts5"）：整体降级 LIKE，避免工具执行崩溃。
    opts.onDegrade?.(error instanceof Error ? error.message : String(error));
    return opts.searchLike(trimmed, opts.limit);
  }
}
