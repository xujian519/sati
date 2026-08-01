/**
 * 专利 wiki 卡片语义索引。
 *
 * 语料：WikiCardLoader 可枚举的全部卡片（~1548 张）；text =
 * title + concept + domain + relatedConcepts + 正文前 800 字。
 * 卡片是静态资产：`syncSource()` 幂等全量同步（textHash 门控，
 * 内容未变化零 embed），删除的卡片从索引移除。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { SemanticDocumentIndex, type VectorIndexEntry } from "../../context/vector/index.js";
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
