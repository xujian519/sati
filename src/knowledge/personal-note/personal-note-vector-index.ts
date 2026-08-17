/**
 * personal_note 语义索引（项目沉淀笔记的语义召回）。
 *
 * 语料：PersonalNoteStore 枚举的 knowledge.db project 笔记（OA 答复要点等）。
 * 与 WikiCardVectorIndex / MemorySemanticIndex 同构（SemanticDocumentIndex 骨架）：
 * 懒加载 JSONL 持久化向量 + textHash 增量 embed + 余弦 top-k。
 *
 * 同步语义：笔记随使用**动态增长**（knowledge_note_save 持续沉淀），故覆写
 * `search()` 在检索前做快照门控增量同步（对齐 MemorySemanticIndex）——新沉淀
 * 的笔记在下次检索即入索引，无需改动写入端工具。笔记集合未变时零成本跳过。
 *
 * 就绪策略：personal_note 量小（数十条内），首次全量 embed 秒级，直接用基类
 * `search()`（自动 warmup），无需像 wiki（千余张）那样"就绪才检索"。embedding
 * 失败由上层（CaseLawSearchEngine.searchSemantic）catch 降级，不阻断关键词路。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { SemanticDocumentIndex, type VectorIndexEntry, type VectorSearchHit } from "../../context/vector/index.js";
import type { PersonalNoteStore } from "./personal-note-store.js";

export type PersonalNoteVectorIndexOptions = {
  store: PersonalNoteStore;
  client: EmbeddingClient;
  storePath: string;
  /** 参与 embed 的正文上限（默认 2000，避免超长笔记撑爆 embedding 请求）。 */
  textMaxChars?: number;
  logger?: { warn?: (...args: unknown[]) => void };
};

const DEFAULT_TEXT_MAX_CHARS = 2000;

export class PersonalNoteVectorIndex extends SemanticDocumentIndex {
  private readonly store: PersonalNoteStore;
  private readonly textMaxChars: number;
  private readonly logger?: { warn?: (...args: unknown[]) => void };
  private lastSnapshotVersion: string | undefined;
  private syncing: Promise<void> | null = null;

  constructor(options: PersonalNoteVectorIndexOptions) {
    super({ client: options.client, storePath: options.storePath, logger: options.logger });
    this.store = options.store;
    this.textMaxChars = options.textMaxChars ?? DEFAULT_TEXT_MAX_CHARS;
    this.logger = options.logger;
  }

  /**
   * 检索前增量同步（快照门控），再走基类 warmup + 余弦 top-k。
   * 同步失败仅告警并沿用已有索引检索——语义是可选增强，绝不阻断。
   */
  override async search(query: string, limit: number): Promise<VectorSearchHit[]> {
    try {
      await this.syncSource();
    } catch (error) {
      this.logger?.warn?.(
        `[personal-note-index] 增量同步失败，沿用已有索引检索: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return super.search(query, limit);
  }

  protected override async syncSource(): Promise<void> {
    const snapshot = this.store.snapshotVersion();
    // 快照读取失败（"" 哨兵）视为数据源不可用：跳过本次同步并保留既有索引，
    // 避免把瞬时读错误当作"笔记清空"触发 stale 整体删除。
    if (!snapshot) {
      this.logger?.warn?.("[personal-note-index] 快照读取失败，跳过本次增量同步（沿用已有索引）");
      return;
    }
    if (this.lastSnapshotVersion === snapshot) return;
    if (this.syncing) {
      await this.syncing;
      return;
    }
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    await this.syncing;
  }

  private async doSync(): Promise<void> {
    // 先捕获快照再读数据：同步期间的新写入会使快照变化，触发下次重同步，
    // 避免“末尾重读快照”的 TOCTOU 把同步窗口内新增的笔记长期漏索引。
    const snapshot = this.store.snapshotVersion();
    // 分页拉取（单条 SQL 的 JOIN + 解压规模有界），聚合语义与 list() 一致。
    const rows = this.store.listAllPaged();
    const entries: VectorIndexEntry[] = [];
    const current = new Set<string>();
    for (const row of rows) {
      const text = this.buildText(row.title, row.content);
      if (!text) continue;
      current.add(row.id);
      entries.push({ id: row.id, text });
    }
    await this.upsert(entries);

    // 移除已从知识库删除的笔记条目（保持索引与数据源一致）。
    const stale = this.listIds().filter(id => !current.has(id));
    if (stale.length > 0) this.remove(stale);

    this.lastSnapshotVersion = snapshot;
  }

  private buildText(title: string, content: string): string {
    const parts: string[] = [];
    if (title.trim()) parts.push(title.trim());
    const body = content.trim();
    if (body) parts.push(body.length > this.textMaxChars ? body.slice(0, this.textMaxChars) : body);
    return parts.join("\n");
  }
}
