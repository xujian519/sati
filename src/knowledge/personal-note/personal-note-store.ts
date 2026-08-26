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
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";

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

/** list() 分页选项（不传时保持全量语义）。 */
export type PersonalNoteListOptions = {
  /** 返回行数上限（作用于 JOIN 行粒度，聚合后可能少于该值）。 */
  limit?: number;
  /** 跳过行数（配合 limit 分页）。 */
  offset?: number;
};

/** 分页单页行数（listAllPaged 用；聚合前合并，文档跨页不拆散）。 */
const PAGE_SIZE = 256;

type PersonalNoteRowSql = {
  id: string;
  title: string;
  indexed_at: string;
  chunk_index: number;
  content: string;
};

export class PersonalNoteStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    this.db = opened.db;
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(this.db);
  }

  /**
   * 列出 project personal_note（id/title/content/indexedAt）。
   * 读取失败时异常上抛（不降级为空数组）——由 PersonalNoteVectorIndex 的
   * search() catch 降级，避免把瞬时读错误当作"笔记清空"触发 stale 整体删除。
   */
  list(options: PersonalNoteListOptions = {}): PersonalNoteRow[] {
    return this.aggregate(this.queryRows(options.limit, options.offset));
  }

  /**
   * 分页拉取全部笔记（每页 PAGE_SIZE 行，聚合语义与 list() 一致）。
   * 供语义索引全量同步使用：单条 SQL 的 JOIN + sati_uncompress 规模有界，
   * 避免一次全量无界扫描（docs 数量增长时内存与单语句耗时可控）。
   */
  listAllPaged(pageSize = PAGE_SIZE): PersonalNoteRow[] {
    const rows: PersonalNoteRowSql[] = [];
    let offset = 0;
    for (;;) {
      const page = this.queryRows(pageSize, offset);
      rows.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return this.aggregate(rows);
  }

  private queryRows(limit: number | undefined, offset: number | undefined): PersonalNoteRowSql[] {
    let sql = `SELECT d.id AS id, d.title AS title, d.indexed_at AS indexed_at,
                      c.chunk_index AS chunk_index, sati_uncompress(c.content) AS content
               FROM documents d
               JOIN chunks c ON c.document_id = d.id
               WHERE d.source = 'project' AND d.doc_type = 'personal_note'
               ORDER BY d.indexed_at DESC, c.chunk_index ASC`;
    const params: Array<string | number> = [];
    if (limit !== undefined && limit > 0) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    if (offset !== undefined && offset > 0) {
      sql += " OFFSET ?";
      params.push(offset);
    }
    return this.db.prepare(sql).all(...params) as PersonalNoteRowSql[];
  }

  /** 一个 document 可能多 chunk：按 id 聚合正文（保持 chunk_index 顺序）。 */
  private aggregate(rows: PersonalNoteRowSql[]): PersonalNoteRow[] {
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
      // 读取失败 → 空串哨兵（调用方跳过本次同步，不碰既有索引）。
      return "";
    }
  }

  close(): void {
    this.db.close();
  }
}
