/**
 * src/knowledge/legal — 法律行映射纯函数。
 *
 * 从 legal-search.ts 拆出（A5 轮次 2）：LawRow 行类型 + 行 → LawRecord /
 * LawSearchResult 映射，零 DB 依赖，可独立单测。
 */

import type { LawRecord, LawSearchResult } from "./types.js";

export type LawRow = {
  id: string;
  level: string;
  name: string;
  filename: string | null;
  publish: string | null;
  expired: number;
  category_id: number;
  subtitle: string | null;
  valid_from: string | null;
  content: string | null;
  category_name: string | null;
  /** FTS5 BM25 分数（负值，越大越相关；仅 FTS 路径有值）。 */
  fts_rank?: number | null;
};

/** 行 → LawRecord（null 列映射为 undefined）。 */
export function toRecord(row: LawRow): LawRecord {
  return {
    id: row.id,
    level: row.level,
    name: row.name,
    filename: row.filename ?? undefined,
    publish: row.publish ?? undefined,
    expired: row.expired,
    categoryId: row.category_id,
    subtitle: row.subtitle ?? undefined,
    validFrom: row.valid_from ?? undefined,
    content: row.content ?? undefined,
    categoryName: row.category_name ?? undefined,
  };
}

/** 行 → LawSearchResult（score = fts_rank ?? 0）。 */
export function toSearchResult(row: LawRow): LawSearchResult {
  return { ...toRecord(row), score: row.fts_rank ?? 0 };
}
