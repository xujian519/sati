/**
 * 通用向量索引：embed → upsert（textHash 增量）→ 持久化 → 余弦 top-k。
 *
 * 设计要点：
 *   - 持久化到 JSONL（见 jsonl-store），启动时惰性加载；
 *   - `upsertMany` 仅对 textHash 变化的条目重新 embed（增量）；
 *   - `search` 全量余弦扫描——语料规模 ≤ 数千条时毫秒级，无需 ANN 索引；
 *   - 上层应 catch embedding 失败并降级（语义检索是可选增强）。
 *   - 只承载 { id, text } → { id, score }，不携带业务元数据
 *     （调用方按 id 自行回查数据源）。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { cosineSimilarity, topK } from "./cosine.js";
import { loadVectorRows, rewriteVectorRows, sha256Text, type StoredVectorRow } from "./jsonl-store.js";

export type VectorIndexEntry = {
  id: string;
  text: string;
};

export type VectorSearchHit = {
  id: string;
  score: number;
};

type IndexedVector = {
  vector: Float32Array;
  textHash: string;
};

export type VectorIndexOptions = {
  client: EmbeddingClient;
  storePath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

export class VectorIndex {
  private readonly client: EmbeddingClient;
  private readonly storePath: string;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private readonly entries = new Map<string, IndexedVector>();
  private warmed = false;

  constructor(options: VectorIndexOptions) {
    this.client = options.client;
    this.storePath = options.storePath;
    this.logger = options.logger;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 惰性加载持久化向量。 */
  async ensureWarmed(): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;
    const rows = loadVectorRows(this.storePath);
    const dimensions = this.client.dimensions || this.inferDimensions(rows);
    for (const row of rows) {
      const vector = Float32Array.from(row.vector);
      if (dimensions > 0 && vector.length > dimensions) {
        this.entries.set(row.id, { vector: vector.subarray(0, dimensions), textHash: row.textHash });
      } else {
        this.entries.set(row.id, { vector, textHash: row.textHash });
      }
    }
  }

  /** 增量 upsert：仅 textHash 变化者重新 embed，随后持久化。 */
  async upsertMany(entries: VectorIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureWarmed();
    const changed: VectorIndexEntry[] = [];
    for (const entry of entries) {
      const textHash = sha256Text(entry.text);
      const existing = this.entries.get(entry.id);
      if (existing && existing.textHash === textHash) continue;
      changed.push(entry);
    }
    if (changed.length === 0) return;

    const vectors = await this.client.embed(changed.map(entry => entry.text));
    changed.forEach((entry, index) => {
      const vector = Float32Array.from(vectors[index] ?? []);
      this.entries.set(entry.id, { vector, textHash: sha256Text(entry.text) });
    });
    this.persist();
  }

  /** 移除条目（如记忆文件被 Dream 压缩删除）。 */
  remove(ids: string[]): void {
    let removed = false;
    for (const id of ids) {
      if (this.entries.delete(id)) removed = true;
    }
    if (removed) this.persist();
  }

  /** 列出当前所有 id（供上层做差集）。 */
  listIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /** 余弦 top-k 检索。embedding 失败时抛出，由上层 catch 降级。 */
  async search(query: string, limit: number): Promise<VectorSearchHit[]> {
    await this.ensureWarmed();
    if (this.entries.size === 0) return [];
    const [queryVector] = await this.client.embed([query]);
    if (!queryVector || queryVector.length === 0) return [];
    const queryVec = Float32Array.from(queryVector);

    const ids: string[] = [];
    const scores = new Float32Array(this.entries.size);
    let index = 0;
    for (const [id, entry] of this.entries) {
      ids[index] = id;
      scores[index] = cosineSimilarity(queryVec, entry.vector);
      index += 1;
    }
    return topK(scores, limit).map(hit => ({ id: ids[hit.index]!, score: hit.score }));
  }

  private inferDimensions(rows: StoredVectorRow[]): number {
    for (const row of rows) {
      if (row.vector.length > 0) return row.vector.length;
    }
    return 0;
  }

  private persist(): void {
    try {
      const rows: StoredVectorRow[] = [];
      for (const [id, entry] of this.entries) {
        rows.push({
          id,
          textHash: entry.textHash,
          updatedAt: new Date().toISOString(),
          vector: Array.from(entry.vector),
        });
      }
      rewriteVectorRows(this.storePath, rows);
    } catch (error) {
      this.logger?.warn?.("[vector-index] persist failed:", error);
    }
  }
}
