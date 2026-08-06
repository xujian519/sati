/**
 * 语义文档索引基类——MemorySemanticIndex 与 WikiCardVectorIndex 的公共骨架。
 *
 * 统一约定：
 *   - 懒加载持久化向量（JSONL）；
 *   - `warmup()` 幂等：首次调用触发一次完整 `syncSource()`，失败复位允许重试，
 *     并发调用去重；
 *   - `search()` = warmup + 余弦 top-k；需要"每次检索前增量同步"的子类
 *     （如记忆正文随会话增长）覆写 `search()` 在 super 之前做快照门控同步；
 *   - `searchIfReady()` = 就绪才检索：warmup 未完成/未启动时返回空数组
 *     （不等待、不阻塞），供"语义是可选增强、未就绪应快速降级"的调用方使用
 *     （如 wiki 卡语义召回——全量 embed 可能数十秒，绝不应阻塞主流程）；
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
  /** warmup 是否已完成（成功）。失败复位后回到 false，允许重试。 */
  private warmupDone = false;

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
      .then(() => {
        this.warmupDone = true;
      })
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

  /**
   * 就绪才检索：warmup 已完成时正常余弦 top-k；未完成/失败时返回空数组。
   *
   * **纯读、无副作用**：不启动、不重试 warmup——预热启动由调用方负责
   * （组装层 warmupSemanticIndex / 检索路径 getSemanticCards 的 fire-and-forget）。
   * 若此处兜底启动，warmup 失败复位后每检索都会重启一次全量 embed（重试风暴），
   * 且未就绪静默返回空会让上层 CircuitBreaker 失去感知。
   */
  async searchIfReady(query: string, limit: number): Promise<VectorSearchHit[]> {
    if (!this.warmupDone) return [];
    return this.index.search(query, limit);
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
