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
