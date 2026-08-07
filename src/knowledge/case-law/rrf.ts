/**
 * 判例双路召回融合（FTS + 语义）。
 *
 * 从 patent_case_search 工具的内联融合逻辑抽取为纯函数，供工具与
 * CaseLawMemoryProvider（判例自动注入）复用，避免两处行为漂移。
 */

import { reciprocalRankFusion } from "../../context/vector/rrf.js";
import type { CaseLawHit } from "./types.js";

/**
 * 判例命中融合：FTS 命中与语义命中按 documentId RRF 融合。
 *
 * 融合去重时 FTS 命中优先保留（via/ftsRank 不丢），语义只填充 FTS
 * 未覆盖的文档；结果截取前 limit 条。任一路为空时直接透传另一路。
 */
export function fuseCaseLawHits(ftsHits: CaseLawHit[], semanticHits: CaseLawHit[], limit: number): CaseLawHit[] {
  if (semanticHits.length === 0) return ftsHits.slice(0, limit);
  const byId = new Map<string, CaseLawHit>();
  for (const hit of ftsHits) byId.set(hit.documentId, hit);
  for (const hit of semanticHits) {
    if (!byId.has(hit.documentId)) byId.set(hit.documentId, hit);
  }
  const fused = reciprocalRankFusion<string>([
    ftsHits.map(hit => ({ id: hit.documentId })),
    semanticHits.map(hit => ({ id: hit.documentId })),
  ]);
  return fused
    .map(item => byId.get(item.id))
    .filter((hit): hit is CaseLawHit => hit !== undefined)
    .slice(0, limit);
}
