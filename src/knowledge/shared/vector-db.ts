/**
 * vectors.db 只读语义检索（阶段 B：KG + 法条离线索引的运行时消费端）。
 *
 * 数据由 scripts/build-knowledge-vectors.ts 生成（见 vector-db-writer.ts）。
 * 检索策略：
 *   - 按 corpus 惰性加载到内存（KG 116K 文档 × 1024 维 int8 ≈ 120MB，
 *     首次搜索该 corpus 时加载并缓存）；
 *   - 连续存储：所有 chunk 向量平铺进一个大 Int8Array，按 doc 记录
 *     [start, end) 偏移，避免 Map 条目内存开销；
 *   - 查询向量同样 int8 量化后做纯 int8 点积（cosine 中 scale 抵消），
 *     chunk 范数在加载时预计算；
 *   - 文档得分取该文档所有 chunk 的最高余弦（chunk 级命中即 doc 命中，
 *     天然支持长文语义召回）。
 */

import { DatabaseSync } from "node:sqlite";
import { int8Dot, l2Norm, quantizeInt8, topK } from "../../context/vector/cosine.js";

export type VectorDbSearchHit = {
  docId: string;
  score: number;
};

export type VectorDbSearchOptions = {
  dbPath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

type CorpusData = {
  dimensions: number;
  /** docId -> 该文档 chunk 在 vectors 中的 [start, end) 区间。 */
  docOffsets: Map<string, { start: number; end: number }>;
  /** 平铺的 chunk 向量（int8）。 */
  vectors: Int8Array;
  /** 每个 chunk 的 L2 范数（加载时预计算）。 */
  norms: Float32Array;
  /** 每个 chunk 的 corpus 内行号（供 docOffsets 引用）。 */
  chunkCount: number;
};

const MIN_QUERY_LENGTH = 3;

export class VectorDbSearch {
  private readonly db: DatabaseSync;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly corpora = new Map<string, { dimensions: number }>();
  private readonly cache = new Map<string, CorpusData>();

  constructor(options: VectorDbSearchOptions) {
    this.db = new DatabaseSync(options.dbPath, { readOnly: true });
    this.logger = options.logger;
    const rows = this.db.prepare("SELECT corpus, dimensions FROM vector_meta").all() as Array<{
      corpus: string;
      dimensions: number;
    }>;
    for (const row of rows) {
      this.corpora.set(row.corpus, { dimensions: row.dimensions });
    }
  }

  /** 语料是否已索引（vector_meta 中有记录）。 */
  hasCorpus(corpus: string): boolean {
    return this.corpora.has(corpus);
  }

  /** 语料维度（无此语料返回 0）。 */
  dimensionsOf(corpus: string): number {
    return this.corpora.get(corpus)?.dimensions ?? 0;
  }

  /** 已加载到内存的 chunk 数（诊断用）。 */
  loadedChunkCount(corpus: string): number {
    return this.cache.get(corpus)?.chunkCount ?? 0;
  }

  /**
   * 语义 top-k：queryVector（float）与语料所有 chunk 求 int8 余弦，
   * 文档得分 = 其 chunk 最高余弦。语料未索引或查询过短返回空数组。
   */
  search(corpus: string, queryVector: Float32Array, limit: number): VectorDbSearchHit[] {
    if (!this.hasCorpus(corpus) || limit <= 0) return [];
    const data = this.loadCorpus(corpus);
    if (data.chunkCount === 0) return [];

    const query = quantizeInt8(queryVector).values;
    const queryNorm = l2Norm(query);

    const docScores = new Map<string, number>();
    for (const [docId, range] of data.docOffsets) {
      let best = -Infinity;
      for (let i = range.start; i < range.end; i += 1) {
        const chunk = data.vectors.subarray(i * data.dimensions, (i + 1) * data.dimensions);
        const dot = int8Dot(query, chunk);
        const normD = data.norms[i] ?? 0;
        if (normD === 0) continue;
        const score = dot / (queryNorm * normD);
        if (score > best) best = score;
      }
      if (best > -Infinity) docScores.set(docId, best);
    }

    const scores = Float32Array.from(docScores.values());
    const ids = Array.from(docScores.keys());
    return topK(scores, limit).map(hit => ({ docId: ids[hit.index]!, score: hit.score }));
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  private loadCorpus(corpus: string): CorpusData {
    const cached = this.cache.get(corpus);
    if (cached) return cached;

    const dimensions = this.corpora.get(corpus)?.dimensions ?? 0;
    if (dimensions <= 0) {
      return {
        dimensions: 0,
        docOffsets: new Map(),
        vectors: new Int8Array(0),
        norms: new Float32Array(0),
        chunkCount: 0,
      };
    }

    const docOffsets = new Map<string, { start: number; end: number }>();
    const chunkBuffers: Int8Array[] = [];
    const norms: number[] = [];

    let currentDocId: string | null = null;
    let currentStart = 0;
    let index = 0;

    // 键集分页加载（WHERE (doc_id, chunk_index) > (?, ?) 走主键前缀索引，
    // 避免 OFFSET 分页在大偏移下重复扫描前序行；ORDER BY 与主键
    // (corpus, doc_id, chunk_index) 一致，天然有序）。
    const PAGE_SIZE = 5000;
    const pageFirst = this.db.prepare(
      "SELECT doc_id, chunk_index, vector FROM vectors WHERE corpus = ? ORDER BY doc_id, chunk_index LIMIT ?",
    );
    const pageNext = this.db.prepare(
      `SELECT doc_id, chunk_index, vector FROM vectors
       WHERE corpus = ? AND (doc_id > ? OR (doc_id = ? AND chunk_index > ?))
       ORDER BY doc_id, chunk_index LIMIT ?`,
    );
    let cursorDocId: string | undefined;
    let cursorChunkIndex = 0;
    while (true) {
      const rows = (
        cursorDocId === undefined
          ? pageFirst.all(corpus, PAGE_SIZE)
          : pageNext.all(corpus, cursorDocId, cursorDocId, cursorChunkIndex, PAGE_SIZE)
      ) as Array<{ doc_id: string; chunk_index: number; vector: Uint8Array }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const chunk = toInt8Array(row.vector, dimensions);
        chunkBuffers.push(chunk);
        norms.push(l2Norm(chunk));
        if (row.doc_id !== currentDocId) {
          if (currentDocId !== null) {
            docOffsets.set(currentDocId, { start: currentStart, end: index });
          }
          currentDocId = row.doc_id;
          currentStart = index;
        }
        index += 1;
      }
      const last = rows[rows.length - 1]!;
      cursorDocId = last.doc_id;
      cursorChunkIndex = last.chunk_index;
    }
    if (currentDocId !== null) {
      docOffsets.set(currentDocId, { start: currentStart, end: index });
    }

    const vectors = new Int8Array(chunkBuffers.length * dimensions);
    for (let i = 0; i < chunkBuffers.length; i += 1) {
      vectors.set(chunkBuffers[i]!, i * dimensions);
    }

    const data: CorpusData = {
      dimensions,
      docOffsets,
      vectors,
      norms: Float32Array.from(norms),
      chunkCount: index,
    };
    this.cache.set(corpus, data);
    this.logger?.warn?.(`[vector-db] loaded corpus "${corpus}": ${docOffsets.size} docs / ${index} chunks.`);
    return data;
  }
}

function toInt8Array(raw: Uint8Array, dimensions: number): Int8Array {
  const view = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return view.length === dimensions ? view : view.subarray(0, dimensions);
}

// 保持 MIN_QUERY_LENGTH 语义化导出（供上层调用方判断是否值得发起语义检索）。
export { MIN_QUERY_LENGTH };
