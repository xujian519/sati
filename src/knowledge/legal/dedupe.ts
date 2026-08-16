/**
 * src/knowledge/legal — 按法律名称去重。
 *
 * 从 legal-search.ts 拆出（A5 轮次 2）：同名多版本（law_fts 按 name 关联 law）
 * 按发布倒序取回后保留最新版本，消除 searchFts / searchFtsKeywords 的重复实现。
 */

/** 按 name 去重，保留首次出现（调用方已按 publish DESC 排序 → 最新版）；到达 limit 即停。 */
export function dedupeByLawName<T extends { name: string }>(rows: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
