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

/**
 * 按法律层级派生来源置信度（0~1，确定性映射；A4 地方法规标记打样——
 * 国家级上位法高、属地法规低，为后续检索置信度标注打样）。
 */
export function lawSourceConfidence(level: string): number {
  switch (level) {
    case "宪法":
      return 1;
    case "法律":
      return 0.95;
    case "行政法规":
      return 0.9;
    case "部门规章":
      return 0.85;
    case "司法解释":
      return 0.8;
    case "地方性法规":
      return 0.6;
    default:
      return 0.7;
  }
}

/** 行 → LawRecord（null 列映射为 undefined；A4 派生 localRegulation/sourceConfidence）。 */
export function toRecord(row: LawRow): LawRecord {
  const localRegulation = row.level === "地方性法规";
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
    ...(localRegulation ? { localRegulation } : {}),
    sourceConfidence: lawSourceConfidence(row.level),
  };
}

/** 行 → LawSearchResult（score = fts_rank ?? 0）。 */
export function toSearchResult(row: LawRow): LawSearchResult {
  return { ...toRecord(row), score: row.fts_rank ?? 0 };
}
