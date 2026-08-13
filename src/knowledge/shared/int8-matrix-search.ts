/**
 * int8 量化 chunk 向量矩阵的共享检索核心（KnowledgeEmbeddingSearch / VectorDbSearch 共用）。
 *
 * 两个语义检索 reader 的数据源不同（vectors 表按 corpus / embeddings 表按 doc_type），
 * 但"加载 → 区间折叠 → int8 点积 top-k"是同一套逻辑，此处提取避免逐字重复：
 *   - loadChunkMatrix：键集分页扫描 (document_id, chunk_id) 有序行，按文档折叠
 *     [start, end) 区间，向量经 decode 转为 int8（float32 源先量化）；
 *   - searchChunkMatrix：查询向量 int8 量化后做纯 int8 点积（cosine 中 scale 抵消），
 *     chunk 范数在加载时预计算，文档得分取该文档所有 chunk 的最高余弦。
 */

import { l2Norm, quantizeInt8 } from "../../context/vector/cosine.js";

export type Int8ChunkMatrix = {
  dimensions: number;
  /** docId -> 该文档 chunk 在 vectors 中的 [start, end) 区间。 */
  docOffsets: Map<string, { start: number; end: number }>;
  /** 平铺的 chunk 向量（int8）。 */
  vectors: Int8Array;
  /** 每个 chunk 的 L2 范数（加载时预计算）。 */
  norms: Float32Array;
  /** 每个 chunk 的 max|v|（Hölder 上界剪枝用，int8 域 ≤127）。 */
  maxAbs: Int8Array;
  chunkCount: number;
};

/** 分页行（与 (document_id, chunk_id) 有序扫描契约）。 */
export type ChunkRow = {
  document_id: string;
  chunk_id: number;
  vector: Uint8Array;
};

/** 键集分页源：pageFirst 取首页，pageNext 取 (docId, chunkId) 之后的行。 */
export type ChunkPageSource = {
  pageFirst(limit: number): ChunkRow[];
  pageNext(cursorDocId: string, cursorChunkId: number, limit: number): ChunkRow[];
};

const PAGE_SIZE = 5000;

/** 空矩阵（无数据时返回，search 恒为空结果）。 */
export function emptyChunkMatrix(dimensions: number): Int8ChunkMatrix {
  return {
    dimensions,
    docOffsets: new Map(),
    vectors: new Int8Array(0),
    norms: new Float32Array(0),
    maxAbs: new Int8Array(0),
    chunkCount: 0,
  };
}

/**
 * 键集分页加载：按 (document_id, chunk_id) 有序扫描（WHERE (document_id, chunk_id) >
 * (?, ?) 走主键/索引前缀，避免 OFFSET 分页在大偏移下重复扫描前序行），按文档折叠
 * [start, end) 区间。向量经 decode 转为 int8 后平铺进大数组，同时预计算每 chunk 范数。
 */
export function loadChunkMatrix(
  source: ChunkPageSource,
  dimensions: number,
  decode: (raw: Uint8Array) => Int8Array,
  onLoaded?: (docCount: number, chunkCount: number) => void,
): Int8ChunkMatrix {
  const docOffsets = new Map<string, { start: number; end: number }>();
  const chunkBuffers: Int8Array[] = [];
  const norms: number[] = [];
  const maxAbs: number[] = [];

  let currentDocId: string | null = null;
  let currentStart = 0;
  let index = 0;

  let cursorDocId: string | undefined;
  let cursorChunkId = 0;
  while (true) {
    const rows =
      cursorDocId === undefined ? source.pageFirst(PAGE_SIZE) : source.pageNext(cursorDocId, cursorChunkId, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const chunk = decode(row.vector);
      chunkBuffers.push(chunk);
      norms.push(l2Norm(chunk));
      // Hölder 上界剪枝预计算：每 chunk 的 max|v|（int8 域 ≤127）。
      let chunkMaxAbs = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        const a = Math.abs(chunk[i] ?? 0);
        if (a > chunkMaxAbs) chunkMaxAbs = a;
      }
      maxAbs.push(chunkMaxAbs);
      if (row.document_id !== currentDocId) {
        if (currentDocId !== null) {
          docOffsets.set(currentDocId, { start: currentStart, end: index });
        }
        currentDocId = row.document_id;
        currentStart = index;
      }
      index += 1;
    }
    const last = rows[rows.length - 1]!;
    // 防御：游标必须严格前进，否则（如分页源列名与 ChunkRow 契约不符）会无限循环
    // 读到同一页直至进程 abort——此处显式失败便于快速定位调用方。
    if (last.document_id === cursorDocId && last.chunk_id === cursorChunkId) {
      throw new Error("int8-matrix-search: 键集分页游标未前进，分页源未按 (document_id, chunk_id) 有序返回");
    }
    cursorDocId = last.document_id;
    cursorChunkId = last.chunk_id;
  }
  if (currentDocId !== null) {
    docOffsets.set(currentDocId, { start: currentStart, end: index });
  }

  const vectors = new Int8Array(chunkBuffers.length * dimensions);
  for (let i = 0; i < chunkBuffers.length; i += 1) {
    vectors.set(chunkBuffers[i]!, i * dimensions);
  }

  onLoaded?.(docOffsets.size, index);
  return {
    dimensions,
    docOffsets,
    vectors,
    norms: Float32Array.from(norms),
    maxAbs: Int8Array.from(maxAbs),
    chunkCount: index,
  };
}

/**
 * 语义 top-k：queryVector（float）与已加载 chunk 求 int8 余弦，
 * 文档得分 = 其 chunk 最高余弦。无数据、维度不匹配或查询过短返回空数组。
 *
 * 无损剪枝：候选超过 limit 后，维护在线阈值 θ = 当前第 limit 大文档得分；
 * 对每个 chunk 用 Hölder 上界 `dot_so_far + ‖q‖₁·maxAbs < θ·‖q‖₂·‖d‖₂` 提前
 * 终止点积（跳过"确定不可能进 topK"的 chunk）。上界为严格上界且 θ 单调不减，
 * 跳过条件与 topK 的"严格大于才替换"语义一致——**返回结果与暴力扫描一致**。
 *
 * 精度说明：V8 对 Float32Array 元素参与的除法可能生成 F32 指令（与 double
 * 计算差 ~1e-8 相对），因此跳过条件带 1e-6 相对安全余量（`< θ·(1-1e-6)`），
 * 保证 F32 舍入噪声下仍不可能把"实际得分 > θ"的 chunk 误剪。
 */
export function searchChunkMatrix(
  data: Int8ChunkMatrix,
  queryVector: Float32Array,
  limit: number,
): Array<{ docId: string; score: number }> {
  if (limit <= 0 || data.chunkCount === 0) return [];
  if (queryVector.length !== data.dimensions) return [];

  const query = quantizeInt8(queryVector).values;
  const queryNorm = l2Norm(query);
  if (queryNorm === 0) return [];

  // 查询向量 L1（Hölder 上界用：Σ|q_i|，一次 O(dim)）。
  let queryL1 = 0;
  for (let i = 0; i < query.length; i += 1) {
    queryL1 += Math.abs(query[i] ?? 0);
  }

  // 在线 topK 候选（降序，长度 ≤ limit；与 topK() 相同的"严格大于才替换"语义）。
  const result: Array<{ docId: string; score: number }> = [];
  const theta = (): number => (result.length === limit ? result[result.length - 1]!.score : -Infinity);

  for (const [docId, range] of data.docOffsets) {
    let best = -Infinity;
    for (let i = range.start; i < range.end; i += 1) {
      const normD = data.norms[i] ?? 0;
      if (normD === 0) continue;
      const threshold = theta() * queryNorm * normD;
      const maxAbs = data.maxAbs[i] ?? 0;
      let dot = 0;
      const base = i * data.dimensions;
      let pruned = false;
      for (let j = 0; j < data.dimensions; j += 1) {
        dot += (query[j] ?? 0) * (data.vectors[base + j] ?? 0);
        // Hölder: 剩余部分和 ≤ Σ|q|·maxAbs（用总 L1 作安全上界）→ dot 最终 ≤ dot + queryL1·maxAbs。
        // 严格小于 + 1e-6 相对余量：跳过条件与 topK"严格大于才替换"对齐，且覆盖 F32 舍入噪声。
        if (dot + queryL1 * maxAbs < threshold * (1 - 1e-6)) {
          pruned = true;
          break;
        }
      }
      if (pruned) continue;
      const score = dot / (queryNorm * normD);
      if (score > best) best = score;
    }
    if (best > -Infinity) {
      if (result.length < limit) {
        result.push({ docId, score: best });
        result.sort((a, b) => b.score - a.score);
      } else if (best > result[result.length - 1]!.score) {
        result[result.length - 1] = { docId, score: best };
        result.sort((a, b) => b.score - a.score);
      }
    }
  }
  return result;
}
