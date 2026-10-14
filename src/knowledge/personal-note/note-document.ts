/**
 * personal_note 文档层写入的唯一实现（直写与草稿确认共用）。
 *
 * `knowledge_note_save`（direct 模式）与 `confirmKnowledgeDraft`（草稿闸门确认）
 * 都必须写同一组表（documents + chunks + docs_fts），收敛于此避免双份插入逻辑漂移。
 *
 * 只写 source='project'、doc_type='personal_note' 的文档行；
 * 不动 kg_nodes / kg_edges / law_article 等核心只读数据。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** 笔记 id：sha1(project|title|content) 前 16 位（幂等键）。 */
export function noteDocumentId(project: string | undefined, title: string, content: string): string {
  return createHash("sha1")
    .update(`${project ?? ""}|${title}|${content}`)
    .digest("hex")
    .slice(0, 16);
}

export type InsertPersonalNoteInput = {
  /** documents.id（noteDocumentId 产物）。调用方负责幂等预检。 */
  documentId: string;
  title: string;
  content: string;
};

/**
 * 在已开启的事务内写入 documents + chunks + docs_fts（contentless FTS，
 * rowid 即 chunks.id）。任一步失败由调用方 ROLLBACK——本函数不做事务边界。
 */
export function insertPersonalNoteDocument(db: DatabaseSync, input: InsertPersonalNoteInput): { charCount: number } {
  const hasFts =
    (
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'").get() as {
        c: number;
      }
    ).c > 0;
  const indexedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO documents (id, source, doc_type, domain, title, indexed_at, char_count, chunk_count, content_hash)
     VALUES (?, 'project', 'personal_note', 'patent', ?, ?, ?, 1, ?)`,
  ).run(input.documentId, input.title, indexedAt, input.content.length, input.documentId);
  const chunk = db
    .prepare(
      `INSERT INTO chunks (document_id, chunk_index, chunk_type, heading, content, char_count)
       VALUES (?, 0, 'paragraph', NULL, ?, ?)`,
    )
    .run(input.documentId, input.content, input.content.length);
  const chunkId = Number(chunk.lastInsertRowid);
  if (hasFts) {
    db.prepare(
      "INSERT INTO docs_fts (rowid, title, content, module, domain, tags) VALUES (?, ?, ?, NULL, 'patent', NULL)",
    ).run(chunkId, input.title, input.content);
  }
  return { charCount: input.content.length };
}
