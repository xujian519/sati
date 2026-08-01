/**
 * 余弦相似度与 top-k 选择（纯 typed array 实现，无依赖）。
 * 同时是 int8 向量数学原语（量化/点积/范数）的规范位置——全仓唯一实现。
 */

/**
 * float 向量 → int8 量化：v/scale 四舍五入并裁剪到 [-127, 127]，scale = maxAbs/127。
 * cosine 计算中 scale 分子分母抵消，量化后余弦 ≈ 原余弦（仅取整误差）。
 */
export function quantizeInt8(vector: Float32Array): { values: Int8Array; scale: number } {
  let maxAbs = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = Math.abs(vector[i] ?? 0);
    if (v > maxAbs) maxAbs = v;
  }
  if (maxAbs === 0) return { values: new Int8Array(vector.length), scale: 1 };
  const scale = maxAbs / 127;
  const values = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const q = Math.round((vector[i] ?? 0) / scale);
    values[i] = Math.max(-127, Math.min(127, q));
  }
  return { values, scale };
}

/** int8 点积。 */
export function int8Dot(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/** int8 L2 范数。 */
export function l2Norm(values: Int8Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * int8 量化向量的余弦相似度（scale 抵消，等价于 float 余弦 + 量化误差）。
 * 适合逐对计算；批量场景建议用 int8Dot + 预计算范数避免重复求范数。
 */
export function cosineSimilarityInt8(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) return 0;
  const dot = int8Dot(a, b);
  const normA = l2Norm(a);
  const normB = l2Norm(b);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * 返回分数最高的 k 个下标（降序）。k 很小（≤50）时用选择排序即可。
 */
export function topK(scores: Float32Array, k: number): Array<{ index: number; score: number }> {
  const limit = Math.max(0, Math.min(k, scores.length));
  if (limit === 0) return [];
  const result: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i] ?? 0;
    if (result.length < limit) {
      result.push({ index: i, score });
      result.sort((a, b) => b.score - a.score);
    } else if (score > result[result.length - 1]!.score) {
      result[result.length - 1] = { index: i, score };
      result.sort((a, b) => b.score - a.score);
    }
  }
  return result;
}
