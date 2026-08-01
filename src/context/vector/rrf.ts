/**
 * Reciprocal Rank Fusion（RRF）——多路召回结果融合。
 *
 * 每路结果按排名计分 `1/(k + rank)`，同 id 累加后降序。k 取 60 是
 * 业界常用值，对小候选集（≤210）表现稳健。
 */

export type RrfRankedItem<T> = { id: T; score?: number };

export function reciprocalRankFusion<T>(
  rankings: Array<Array<RrfRankedItem<T>>>,
  k = 60,
): Array<{ id: T; score: number }> {
  const scores = new Map<T, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, index) => {
      const contribution = 1 / (k + index + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    });
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
