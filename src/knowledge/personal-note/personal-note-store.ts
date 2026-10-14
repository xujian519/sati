/**
 * personal_note 只读数据源（WS2.1：Sati 自有 sati-notes.db 的 notes 真源表）。
 *
 * knowledge.db（XiaoNuo 管道产物，文件级整体替换）只承载可重建的检索投影；
 * 语义索引的数据源是 sidecar——管道刷新后由写路径签名检测自动重投影，
 * 本 store 无需关心投影面。
 *
 * 只读边界：仅 SELECT，不写 sati-notes.db；读连接不阻塞工具侧短连接写入
 * （journal_mode=delete 下写锁短暂）。
 */

import { DatabaseSync } from "node:sqlite";
import { ensureNotesDb } from "./notes-db.js";

/** 一条 personal_note（notes 真源行）。 */
export type PersonalNoteRow = {
  /** notes.id（noteDocumentId：sha1(project|title|content) 前 16 位）。 */
  id: string;
  title: string;
  /** 正文（sidecar 单表全量存储，无 chunk 聚合）。 */
  content: string;
  /** notes.updated_at（ISO 字符串，参与快照版本）。 */
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
  updated_at: string;
  content: string;
};

export class PersonalNoteStore {
  private readonly db: DatabaseSync;

  constructor(notesDbPath: string, options: { knowledgeDb?: string } = {}) {
    // ensure（含一次性导入）后再只读打开：sidecar 由本模块独家写入，
    // 长驻只读连接与短连接写入不冲突（autocommit SELECT 不持锁）。
    ensureNotesDb(notesDbPath, options.knowledgeDb).close();
    this.db = new DatabaseSync(notesDbPath, { readOnly: true });
  }

  /**
   * 列出全部沉淀笔记（updated_at 倒序）。
   * 读取失败时异常上抛（不降级为空数组）——由 PersonalNoteVectorIndex 的
   * search() catch 降级，避免把瞬时读错误当作"笔记清空"触发 stale 整体删除。
   */
  list(options: PersonalNoteListOptions = {}): PersonalNoteRow[] {
    let sql = "SELECT id, title, content, updated_at FROM notes ORDER BY updated_at DESC";
    const params: Array<string | number> = [];
    if (options.limit !== undefined && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset !== undefined && options.offset > 0) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as PersonalNoteRowSql[];
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      content: row.content,
      indexedAt: row.updated_at,
    }));
  }

  /**
   * 分页拉取全部笔记（每页 pageSize 行）。
   * 供语义索引全量同步使用：单条 SQL 规模有界，避免一次全量无界扫描。
   */
  listAllPaged(pageSize = PAGE_SIZE): PersonalNoteRow[] {
    const rows: PersonalNoteRowSql[] = [];
    let offset = 0;
    for (;;) {
      const page = this.db
        .prepare("SELECT id, title, content, updated_at FROM notes ORDER BY updated_at DESC LIMIT ? OFFSET ?")
        .all(pageSize, offset) as unknown as PersonalNoteRowSql[];
      rows.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      content: row.content,
      indexedAt: row.updated_at,
    }));
  }

  /**
   * 快照版本：`count:maxUpdatedAt`。供增量同步门控——笔记集合未变时零成本跳过。
   * 读取失败返回空串（哨兵：调用方视为数据源不可用，跳过本次同步、不碰既有索引）。
   */
  snapshotVersion(): string {
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM notes").get() as {
        c: number;
        m: string;
      };
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
