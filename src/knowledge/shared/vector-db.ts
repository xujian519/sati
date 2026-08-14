/**
 * vectors.db 只读语义检索（阶段 B：KG + 法条离线索引的运行时消费端；legacy）。
 *
 * 数据由 scripts/build-knowledge-vectors.ts 生成（见 vector-db-writer.ts）。
 * 检索策略（共享核心见 int8-matrix-search.ts，与 knowledge-embeddings.ts 同构）：
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
import {
  emptyChunkMatrix,
  loadChunkMatrix,
  searchChunkMatrix,
  type ChunkRow,
  type Int8ChunkMatrix,
} from "./int8-matrix-search.js";
import { KnowledgeDbVersionError, openKnowledgeDb } from "./db-version.js";
import { VECTORS_DB } from "./schema-versions.js";

export type VectorDbSearchHit = {
  docId: string;
  score: number;
};

export type VectorDbSearchOptions = {
  dbPath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

const MIN_QUERY_LENGTH = 3;

export class VectorDbSearch {
  private readonly db: DatabaseSync;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly corpora = new Map<string, { dimensions: number }>();
  private readonly cache = new Map<string, Int8ChunkMatrix>();

  constructor(options: VectorDbSearchOptions) {
    // vectors.db 为可重建的派生索引：版本过旧时报错，由上层（assemble.ts）
    // 降级跳过语义召回，提示重建而非静默读旧格式。
    const opened = openKnowledgeDb(options.dbPath, VECTORS_DB, { readOnly: true, treatZeroAsStale: true });
    if (opened.needsRebuild) {
      opened.db.close();
      throw new KnowledgeDbVersionError(
        options.dbPath,
        "vectors.db 版本过旧，请重新运行 scripts/build-knowledge-vectors.ts 重建",
        { currentVersion: opened.version, expectedVersion: VECTORS_DB.version },
      );
    }
    this.db = opened.db;
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
    return searchChunkMatrix(this.loadCorpus(corpus), queryVector, limit);
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  private loadCorpus(corpus: string): Int8ChunkMatrix {
    const cached = this.cache.get(corpus);
    if (cached) return cached;

    const dimensions = this.corpora.get(corpus)?.dimensions ?? 0;
    if (dimensions <= 0) {
      const empty = emptyChunkMatrix(0);
      this.cache.set(corpus, empty);
      return empty;
    }

    // 键集分页加载（WHERE (doc_id, chunk_index) > (?, ?) 走主键前缀索引，
    // 避免 OFFSET 分页在大偏移下重复扫描前序行；ORDER BY 与主键
    // (corpus, doc_id, chunk_index) 一致，天然有序）。
    // 列别名对齐 int8-matrix-search 的 ChunkRow 契约（document_id/chunk_id）。
    const pageFirst = this.db.prepare(
      "SELECT doc_id AS document_id, chunk_index AS chunk_id, vector FROM vectors WHERE corpus = ? ORDER BY doc_id, chunk_index LIMIT ?",
    );
    const pageNext = this.db.prepare(
      `SELECT doc_id AS document_id, chunk_index AS chunk_id, vector FROM vectors
       WHERE corpus = ? AND (doc_id > ? OR (doc_id = ? AND chunk_index > ?))
       ORDER BY doc_id, chunk_index LIMIT ?`,
    );

    const data = loadChunkMatrix(
      {
        pageFirst: limit => pageFirst.all(corpus, limit) as ChunkRow[],
        pageNext: (docId, chunkIndex, limit) => pageNext.all(corpus, docId, docId, chunkIndex, limit) as ChunkRow[],
      },
      dimensions,
      raw => toInt8Array(raw, dimensions),
      (docCount, chunkCount) =>
        this.logger?.warn?.(`[vector-db] loaded corpus "${corpus}": ${docCount} docs / ${chunkCount} chunks.`),
    );
    this.cache.set(corpus, data);
    return data;
  }
}

function toInt8Array(raw: Uint8Array, dimensions: number): Int8Array {
  const view = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return view.length === dimensions ? view : view.subarray(0, dimensions);
}

// 保持 MIN_QUERY_LENGTH 语义化导出（供上层调用方判断是否值得发起语义检索）。
export { MIN_QUERY_LENGTH };
