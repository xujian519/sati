/**
 * personal_note 只读数据源（knowledge.db documents/chunks）。
 *
 * `knowledge_note_save` 工具把项目沉淀（OA 答复要点、无效结论、检索心得）写入
 * documents（source='project'、doc_type='personal_note'）+ chunks + docs_fts。
 * 本 store 以只读连接枚举这些笔记，供 PersonalNoteVectorIndex 建语义向量。
 *
 * 只读边界：仅 SELECT，不写 knowledge.db；读连接不阻塞 knowledge_note_save
 * 的短连接事务写入（journal_mode=delete 下写锁短暂）。
 */

import { DatabaseSync } from "node:sqlite";
import { registerChunkUncompress } from "../shared/chunk-compression.js";

/** 一条 personal_note（documents 行 + 聚合后的 chunk 正文）。 */
export type PersonalNoteRow = {
  /** documents.id（noteDocumentId：sha1(project|title|content) 前 16 位）。 */
  id: string;
  title: string;
  /** 全部 chunk 正文按 chunk_index 拼接（personal_note 通常单 chunk）。 */
  content: string;
  /** documents.indexed_at（ISO 字符串，参与快照版本）。 */
  indexedAt: string;
};

export class PersonalNoteStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(this.db);
  }

  /**
   * 列出全部 project personal_note（id/title/content/indexedAt）。
   * 读取失败时异常上抛（不降级为空数组）——由 PersonalNoteVectorIndex 的
   * search() catch 降级，避免把瞬时读错误当作"笔记清空"触发 stale 整体删除。
   */
  list(): PersonalNoteRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.id AS id, d.title AS title, d.indexed_at AS indexed_at,
                c.chunk_index AS chunk_index, sati_uncompress(c.content) AS content
         FROM documents d
         JOIN chunks c ON c.document_id = d.id
         WHERE d.source = 'project' AND d.doc_type = 'personal_note'
         ORDER BY d.indexed_at DESC, c.chunk_index ASC`,
      )
      .all() as Array<{ id: string; title: string; indexed_at: string; chunk_index: number; content: string }>;

    // 一个 document 可能多 chunk：按 id 聚合正文（保持 chunk_index 顺序）。
    const byId = new Map<string, PersonalNoteRow & { parts: string[] }>();
    for (const row of rows) {
      let entry = byId.get(row.id);
      if (!entry) {
        entry = { id: row.id, title: row.title, content: "", indexedAt: row.indexed_at, parts: [] };
        byId.set(row.id, entry);
      }
      entry.parts.push(row.content);
    }
    return Array.from(byId.values()).map(entry => ({
      id: entry.id,
      title: entry.title,
      content: entry.parts.join("\n"),
      indexedAt: entry.indexedAt,
    }));
  }

  /**
   * 快照版本：`count:maxIndexedAt`。供增量同步门控——笔记集合未变时零成本跳过。
   * 读取失败返回空串（哨兵：调用方视为数据源不可用，跳过本次同步、不碰既有索引）。
   */
  snapshotVersion(): string {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(MAX(indexed_at), '') AS m
           FROM documents WHERE source = 'project' AND doc_type = 'personal_note'`,
        )
        .get() as { c: number; m: string };
      return `${row.c}:${row.m}`;
    } catch {
      return "";
    }
  }

  close(): void {
    this.db.close();
  }
}
