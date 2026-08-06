/**
 * knowledge.db embeddings 只读语义检索（复用 XiaoNuo 管道产物，零重新构建）。
 *
 * 数据：knowledge.db `embeddings` 表（float32 × dim，bge-m3 1024 维，norm≈1.0，
 * XiaoNuo `@nuo/knowledge` 管道生成），chunk 经 `chunks.document_id` 归属文档。
 *
 * 检索策略（共享核心见 int8-matrix-search.ts，与 vector-db.ts 同构）：
 *   - 惰性加载：float32 → 加载时 int8 量化（1024 维 × 144K chunk ≈ 147MB 内存；
 *     全量 float32 590MB 不可行），首次 search 加载并缓存；
 *   - 连续存储：所有 chunk 向量平铺进一个大 Int8Array，按 doc 记录 [start, end) 偏移；
 *   - 查询向量同样 int8 量化后做纯 int8 点积（cosine 中 scale 抵消），
 *     chunk 范数在加载时预计算；
 *   - 文档得分取该文档所有 chunk 的最高余弦；可选 doc_type 白名单过滤加载。
 *   - available 在构造时以 docTypes 过滤后的轻量 COUNT 判定，docTypes 无命中时
 *     直接不可用，避免语义路每次查询空转（embed 调用浪费）。
 */

import { DatabaseSync } from "node:sqlite";
import { quantizeInt8 } from "../../context/vector/cosine.js";
import { loadChunkMatrix, searchChunkMatrix, type ChunkRow, type Int8ChunkMatrix } from "./int8-matrix-search.js";

export type KnowledgeEmbeddingHit = {
  /** documents.id（如 "raw:无效复审决定:..." / "wiki:..." / "law:..."）。 */
  docId: string;
  score: number;
};

export type KnowledgeEmbeddingSearchOptions = {
  /** knowledge.db 路径。 */
  dbPath: string;
  logger?: { warn?: (...args: unknown[]) => void };
  /** 可选 doc_type 白名单（如 ["case","judgment"] / ["law_article"]）；缺省全部。 */
  docTypes?: string[];
};

export class KnowledgeEmbeddingSearch {
  private readonly db: DatabaseSync;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly docTypes?: string[];
  private readonly dimensions: number;
  /** docTypes 过滤后是否有可检索向量（构造时一次 COUNT；无命中直接不可用）。 */
  private readonly hasData: boolean;
  /** doc_type 过滤 SQL 片段（空 docTypes 时为空串，热路径免拼接）。 */
  private readonly joinSql: string;
  private readonly filterSql: string;
  private readonly filterParams: string[];
  private data?: Int8ChunkMatrix;

  constructor(options: KnowledgeEmbeddingSearchOptions) {
    this.db = new DatabaseSync(options.dbPath, { readOnly: true });
    this.logger = options.logger;
    this.docTypes = options.docTypes;

    const filterList = this.docTypes && this.docTypes.length > 0 ? this.docTypes : undefined;
    this.joinSql = filterList ? " JOIN documents d ON d.id = e.document_id" : "";
    this.filterSql = filterList ? ` WHERE d.doc_type IN (${filterList.map(() => "?").join(",")})` : "";
    this.filterParams = filterList ?? [];

    // 探测 embeddings 表：按 dim 分组取最主流的维度（防御多维度混存）。
    const meta = this.db
      .prepare("SELECT dim, COUNT(*) AS c FROM embeddings GROUP BY dim ORDER BY c DESC LIMIT 1")
      .get() as { dim: number; c: number } | undefined;
    this.dimensions = meta?.dim ?? 0;
    if (meta && meta.c > 0) {
      this.hasData = this.countFiltered() > 0;
      this.logger?.warn?.(`[knowledge-embeddings] 可用：${meta.c} chunk，dim=${meta.dim}`);
    } else {
      this.hasData = false;
    }
  }

  /** embeddings 表是否有可检索数据（含 docTypes 过滤后无命中的情形）。 */
  get available(): boolean {
    return this.dimensions > 0 && this.hasData;
  }

  /** 已加载到内存的 chunk 数（诊断用）。 */
  loadedChunkCount(): number {
    return this.data?.chunkCount ?? 0;
  }

  /** 生效的 doc_type 过滤（诊断用）。 */
  docTypeFilter(): string[] | undefined {
    return this.docTypes;
  }

  /**
   * 语义 top-k：queryVector（float）与已加载 chunk 求 int8 余弦，
   * 文档得分 = 其 chunk 最高余弦。无数据、维度不匹配或查询过短返回空数组。
   */
  search(queryVector: Float32Array, limit: number): KnowledgeEmbeddingHit[] {
    if (!this.available || limit <= 0) return [];
    if (queryVector.length !== this.dimensions) return [];
    return searchChunkMatrix(this.load(), queryVector, limit);
  }

  close(): void {
    this.data = undefined;
    this.db.close();
  }

  /** docTypes 过滤后的向量条数（构造时一次轻量 COUNT；无过滤即全表 COUNT）。 */
  private countFiltered(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM embeddings e${this.joinSql}${this.filterSql}`)
      .get(...this.filterParams) as { c: number };
    return row.c;
  }

  private load(): Int8ChunkMatrix {
    if (this.data) return this.data;
    const dimensions = this.dimensions;
    const filterParams = this.filterParams;

    // 键集分页加载（WHERE (document_id, chunk_id) > (?, ?) 走主键/索引前缀，
    // 避免 OFFSET 分页在大偏移下重复扫描前序行；ORDER BY 与排序一致，天然有序）。
    const pageFirst = this.db.prepare(
      `SELECT e.document_id, e.chunk_id, e.vector FROM embeddings e${this.joinSql}${this.filterSql}
       ORDER BY e.document_id, e.chunk_id LIMIT ?`,
    );
    const pageNext = this.db.prepare(
      `SELECT e.document_id, e.chunk_id, e.vector FROM embeddings e${this.joinSql}${this.filterSql}
       ${this.filterSql ? "AND" : "WHERE"} (e.document_id > ? OR (e.document_id = ? AND e.chunk_id > ?))
       ORDER BY e.document_id, e.chunk_id LIMIT ?`,
    );

    const data = loadChunkMatrix(
      {
        pageFirst: limit => pageFirst.all(...filterParams, limit) as ChunkRow[],
        pageNext: (docId, chunkId, limit) => pageNext.all(...filterParams, docId, docId, chunkId, limit) as ChunkRow[],
      },
      dimensions,
      raw => quantizeInt8(toFloat32Array(raw, dimensions)).values,
      (docCount, chunkCount) =>
        this.logger?.warn?.(`[knowledge-embeddings] 已加载：${docCount} docs / ${chunkCount} chunks。`),
    );
    this.data = data;
    return data;
  }
}

/** BLOB(float32 LE) → Float32Array；长度超维度时截断，不足时补零。 */
function toFloat32Array(raw: Uint8Array, dimensions: number): Float32Array {
  const view = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  if (view.length === dimensions) return view;
  const out = new Float32Array(dimensions);
  out.set(view.subarray(0, dimensions));
  return out;
}
