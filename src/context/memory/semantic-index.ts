/**
 * 记忆正文语义索引（父包实现，edgeclaw-memory-core 零依赖）。
 *
 * 数据源 = EdgeClawMemoryService 已暴露的 `list` / `get` / `getSnapshotVersion`：
 * `syncSource()` 每次检索前做**增量同步**（快照版本门控：仅内容变化时重嵌入
 * 变化条目/移除删除条目；本地 list+read 毫秒级，快照未变化零成本）。
 */

import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import type { EmbeddingClient } from "../../model/embedding/types.js";
import { SemanticDocumentIndex, type VectorIndexEntry, type VectorSearchHit } from "../vector/index.js";

type MemoryListEntry = { relativePath: string };
type MemoryRecord = { relativePath: string; content: string };

export type MemorySemanticIndexOptions = {
  service: Pick<EdgeClawMemoryService, "list" | "get" | "getSnapshotVersion">;
  client: EmbeddingClient;
  storePath: string;
  /** 最多索引的记忆文件数（默认 500，覆盖 manifest 上限 200 之外的历史）。 */
  maxFiles?: number;
  /** 每个记忆文件参与索引的正文行数上限（默认 200，与 recall 读取一致）。 */
  maxLinesPerFile?: number;
  logger?: { warn?: (...args: unknown[]) => void };
};

export class MemorySemanticIndex extends SemanticDocumentIndex {
  private readonly service: MemorySemanticIndexOptions["service"];
  private readonly maxFiles: number;
  private readonly maxLinesPerFile: number;
  private lastSnapshotVersion: string | undefined;
  private syncing: Promise<void> | null = null;

  constructor(options: MemorySemanticIndexOptions) {
    super({ client: options.client, storePath: options.storePath, logger: options.logger });
    this.service = options.service;
    this.maxFiles = options.maxFiles ?? 500;
    this.maxLinesPerFile = options.maxLinesPerFile ?? 200;
  }

  /**
   * 语义命中（id 即记忆文件 relativePath；调用方按需映射命名）。
   * 检索前做增量同步（快照门控）。
   */
  override async search(query: string, limit: number): Promise<VectorSearchHit[]> {
    await this.syncSource();
    return super.search(query, limit);
  }

  protected override async syncSource(): Promise<void> {
    const snapshot = this.service.getSnapshotVersion();
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
    const entries = this.service.list({ limit: this.maxFiles }) as MemoryListEntry[];
    const ids = entries.map(entry => entry.relativePath);
    const records = this.service.get(ids, this.maxLinesPerFile) as MemoryRecord[];
    const byId = new Map(records.map(record => [record.relativePath, record]));

    const toIndex: VectorIndexEntry[] = [];
    const current = new Set<string>();
    for (const id of ids) {
      const content = byId.get(id)?.content?.trim();
      if (!content) continue;
      current.add(id);
      toIndex.push({ id, text: content });
    }
    await this.upsert(toIndex);

    // 移除已被删除/清空的记忆文件条目（如 Dream 压缩后）。
    const stale = this.listIds().filter(id => !current.has(id));
    if (stale.length > 0) this.remove(stale);

    this.lastSnapshotVersion = this.service.getSnapshotVersion();
  }
}
