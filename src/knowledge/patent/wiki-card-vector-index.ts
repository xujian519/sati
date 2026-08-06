/**
 * 专利 wiki 卡片语义索引。
 *
 * 语料：WikiCardLoader 可枚举的全部卡片（~1548 张）；text =
 * title + concept + domain + relatedConcepts + 正文前 800 字。
 *
 * 同步语义（2026-08 简化）：**语料静态**——WikiCardLoader 是一次性快照
 * （ensureLoaded 置位后不再重扫目录），provider 单例持有同一 loader 实例，
 * 卡片集在运行时不变。故不覆写 search 做检索前增量同步：基类 warmup 首次
 * 全量构建（textHash 门控，内容未变零 embed）并持久化即可，之后零成本。
 * 若未来卡片集可变（loader 支持刷新），需在换 loader 实例时重建本索引，
 * 或恢复"检索前快照门控"覆写。
 *
 * 就绪才检索（2026-08 变更）：`search` 覆写为基类 `searchIfReady` 语义——
 * warmup 未完成（含首次全量 embed，本地 Ollama 下约百秒级）时**直接返回空**
 * 而非阻塞等待，确保语义召回是可选增强、绝不拖慢主流程。预热由组装层
 * 启动时后台触发（buildKnowledgeResolvers → warmupSemanticIndex）。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { SemanticDocumentIndex, type VectorIndexEntry, type VectorSearchHit } from "../../context/vector/index.js";
import { WikiCardLoader } from "./wiki-card-loader.js";

export type WikiCardVectorIndexOptions = {
  loader: WikiCardLoader;
  client: EmbeddingClient;
  storePath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

const CARD_TEXT_MAX_CHARS = 800;

export class WikiCardVectorIndex extends SemanticDocumentIndex {
  private readonly loader: WikiCardLoader;

  constructor(options: WikiCardVectorIndexOptions) {
    super({ client: options.client, storePath: options.storePath, logger: options.logger });
    this.loader = options.loader;
  }

  /**
   * 就绪才检索：warmup（首次全量 embed）未完成时返回空数组，不阻塞。
   * 首次调用会兜底启动后台预热；此后每轮零成本判断，就绪即正常 top-k。
   */
  override async search(query: string, limit: number): Promise<VectorSearchHit[]> {
    return this.searchIfReady(query, limit);
  }

  protected override async syncSource(): Promise<void> {
    const metas = this.loader.list(100_000);
    const entries: VectorIndexEntry[] = metas.map(meta => ({ id: meta.id, text: this.buildCardText(meta.id) }));
    await this.upsert(entries);

    // 移除已不存在于语料的陈旧条目（如卡片被删除）。
    const current = new Set(metas.map(meta => meta.id));
    const stale = this.listIds().filter(id => !current.has(id));
    if (stale.length > 0) this.remove(stale);
  }

  private buildCardText(id: string): string {
    const meta = this.loader.getById(id);
    const parts: string[] = [];
    if (meta) {
      if (meta.title) parts.push(meta.title);
      if (meta.concept) parts.push(`概念:${meta.concept}`);
      if (meta.domain) parts.push(`领域:${meta.domain}`);
      if (meta.relatedConcepts?.length) parts.push(`相关:${meta.relatedConcepts.join(" ")}`);
    }
    const body = this.loader.formatAsContext(id, CARD_TEXT_MAX_CHARS);
    if (body) parts.push(body);
    return parts.join("\n");
  }
}
