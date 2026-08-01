/**
 * 语义文档索引基类——MemorySemanticIndex 与 WikiCardVectorIndex 的公共骨架。
 *
 * 统一约定：
 *   - 懒加载持久化向量（JSONL）；
 *   - `warmup()` 幂等：首次调用触发一次完整 `syncSource()`，失败复位允许重试，
 *     并发调用去重；
 *   - `search()` = warmup + 余弦 top-k；需要"每次检索前增量同步"的子类
 *     （如记忆正文随会话增长）覆写 `search()` 在 super 之前做快照门控同步；
 *   - 索引只存 { id, text } → { id, score }，业务元数据由调用方按 id 回查。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { VectorIndex, type VectorIndexEntry, type VectorSearchHit } from "./vector-index.js";

export type SemanticDocumentIndexOptions = {
  client: EmbeddingClient;
  storePath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

export abstract class SemanticDocumentIndex {
  private readonly index: VectorIndex;
  private warmupStarted = false;
  private warmupPromise: Promise<void> | null = null;

  protected constructor(options: SemanticDocumentIndexOptions) {
    this.index = new VectorIndex({ client: options.client, storePath: options.storePath, logger: options.logger });
  }

  get size(): number {
    return this.index.size;
  }

  /** 幂等预热：首次触发完整同步，失败复位允许重试，并发去重。 */
  async warmup(): Promise<void> {
    if (this.warmupStarted) {
      if (this.warmupPromise) await this.warmupPromise;
      return;
    }
    this.warmupStarted = true;
    this.warmupPromise = this.doWarmup()
      .catch(error => {
        this.warmupStarted = false;
        this.warmupPromise = null;
        throw error;
      })
      .finally(() => {
        this.warmupPromise = null;
      });
    await this.warmupPromise;
  }

  /** 余弦 top-k；embedding 失败时抛出，由上层 catch 降级。 */
  async search(query: string, limit: number): Promise<VectorSearchHit[]> {
    await this.warmup();
    return this.index.search(query, limit);
  }

  /** 子类实现：把数据源同步进索引（仅 textHash 变化者重嵌入，删除的移除）。 */
  protected abstract syncSource(): Promise<void>;

  protected async upsert(entries: VectorIndexEntry[]): Promise<void> {
    await this.index.upsertMany(entries);
  }

  protected remove(ids: string[]): void {
    this.index.remove(ids);
  }

  protected listIds(): string[] {
    return this.index.listIds();
  }

  private async doWarmup(): Promise<void> {
    await this.index.ensureWarmed();
    await this.syncSource();
  }
}
