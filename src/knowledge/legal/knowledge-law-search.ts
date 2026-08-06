/**
 * knowledge.db 法规全文搜索引擎（law_article 文档）。
 *
 * 数据源：knowledge.db `documents`(doc_type='law_article') / `chunks` /
 * `docs_fts`（contentless FTS5 trigram）。docs_fts rowid = chunks.id，
 * 正文经 JOIN chunks/documents 回源（与 case-law-search 同模式）。
 *
 * 与 LegalSearchEngine（laws-full.db）接口对齐，供 LegalMemoryProvider
 * 作为知识库法规后端（复用 XiaoNuo 产物，不再依赖 laws-full）。
 *
 * LawRecord 映射：
 *   id     = documents.id（如 "raw:法律法规司法解释_md:中华人民共和国专利法_20201017"）
 *   name   = documents.title（法规名）
 *   level  = documents.level（法律/行政法规/司法解释/部门规章…）
 *   content= 该文档最长 chunk（法规章节片段，注入上下文时截断）
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { FTS_MIN_RUNES, sqliteHasFts5 } from "../shared/fts.js";
import type { LawCategory, LawRecord, LawSearchResult, LegalSearchSource } from "./types.js";
import { extractLawKeywords } from "./legal-search.js";

export type KnowledgeLawSearchOptions = {
  /** 返回条数上限（默认 10）。 */
  limit?: number;
  /** 按法律层级过滤（法律/行政法规/司法解释/部门规章…）。 */
  level?: string;
  /** 分类过滤：knowledge.db 无 category 概念，忽略。 */
  category?: string;
};

type DocChunkRow = {
  document_id: string;
  title: string;
  level: string | null;
  source: string | null;
  content: string | null;
  chunk_index: number;
  char_count: number | null;
  /** FTS5 BM25 分数（负值，越大越相关；仅 FTS 路径有值）。 */
  fts_rank?: number | null;
};

const FETCH_MULTIPLIER = 3;

export class KnowledgeLawSearch implements LegalSearchSource {
  private readonly db: DatabaseSync;
  private readonly hasFts: boolean;
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  private ftsDegraded = false;

  private readonly stmtSearchLike: StatementSync;
  private readonly stmtSearchFts: StatementSync | null;
  private readonly stmtFindByName: StatementSync;
  private readonly stmtGetById: StatementSync;
  private readonly stmtCount: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'")
      .get() as { c: number };
    this.hasFts = row.c > 0 && sqliteHasFts5(this.db);

    // LIKE 降级：documents.title 或每文档最长 chunk 的 content；子查询取最长 chunk 作片段。
    this.stmtSearchLike = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source, c.content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article'
        AND (d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')
      ORDER BY d.char_count DESC LIMIT ?
    `);
    this.stmtSearchFts = null;
    if (this.hasFts) {
      try {
        this.stmtSearchFts = this.db.prepare(`
          SELECT d.id AS document_id, d.title, d.level, d.source,
                 c.content, c.char_count, bm25(docs_fts) AS fts_rank
          FROM docs_fts
          JOIN chunks c ON c.id = docs_fts.rowid
          JOIN documents d ON d.id = c.document_id
          WHERE docs_fts MATCH ? AND d.doc_type = 'law_article'
          ORDER BY bm25(docs_fts) LIMIT ?
        `);
      } catch {
        this.ftsDegraded = true;
        this.stmtSearchFts = null;
      }
    }
    this.stmtFindByName = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source, c.content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article' AND d.title LIKE ? ESCAPE '\\'
      LIMIT ?
    `);
    this.stmtGetById = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source, c.content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.id = ?
    `);
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = 'law_article'");
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded;
  }

  /** 法规全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；按文档去重。 */
  search(keyword: string, options: KnowledgeLawSearchOptions = {}): LawSearchResult[] {
    const limit = options.limit ?? 10;
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const runes = Array.from(trimmed);
    let rows: DocChunkRow[];
    if (!this.hasFts || this.ftsDegraded || runes.length < FTS_MIN_RUNES) {
      rows = this.searchLike(trimmed, options, limit);
    } else {
      try {
        // 1. 整句 phrase（短查询命中率高）
        rows = this.searchFts(trimmed, options, limit);
        // 2. 整句无命中时切词 OR 查询（长句/自然语言查询）
        if (rows.length === 0) {
          const keywords = extractLawKeywords(trimmed);
          if (keywords.length > 0 && keywords[0] !== trimmed) {
            rows = this.searchFtsKeywords(keywords, options, limit);
          }
        }
        // 3. FTS 仍无命中时降级 LIKE
        if (rows.length === 0) {
          rows = this.searchLike(trimmed, options, limit);
        }
      } catch {
        this.ftsDegraded = true;
        rows = this.searchLike(trimmed, options, limit);
      }
    }

    return rows.map(row => this.toSearchResult(row));
  }

  /** 按法规名模糊查找（返回全部匹配文档）。 */
  findByName(name: string, limit = 10): LawRecord[] {
    const pattern = `%${name.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    const rows = this.stmtFindByName.all(pattern, limit) as DocChunkRow[];
    return rows.map(row => this.toRecord(row));
  }

  /** 按 documents.id 精确查询（语义路回源）。 */
  getById(id: string): LawRecord | undefined {
    const row = this.stmtGetById.get(id) as DocChunkRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  /** 批量按 documents.id 查询（一次 IN 查询）。 */
  getByIds(ids: string[]): LawRecord[] {
    const unique = Array.from(new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
    if (unique.length === 0) return [];
    if (unique.length === 1) {
      const record = this.getById(unique[0]!);
      return record ? [record] : [];
    }
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT d.id AS document_id, d.title, d.level, d.source,
               c.content, c.char_count
        FROM documents d
        JOIN chunks c ON c.id = (
          SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
        WHERE d.doc_type = 'law_article' AND d.id IN (${placeholders})
      `)
      .all(...unique) as DocChunkRow[];
    const byId = new Map(rows.map(row => [row.document_id, this.toRecord(row)]));
    return unique.map(id => byId.get(id)).filter((r): r is LawRecord => r !== undefined);
  }

  /** knowledge.db 无分类概念，返回空数组（接口对齐）。 */
  getCategories(): LawCategory[] {
    return [];
  }

  /** 法规文档总数（诊断用）。 */
  count(): number {
    const row = this.stmtCount.get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }

  private searchFts(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const escaped = keyword.replace(/"/g, '""');
    const rows = this.withLevelFilter(`"${escaped}"`, options, limit * FETCH_MULTIPLIER) as DocChunkRow[];
    return this.dedupeByDocument(rows, limit);
  }

  private searchFtsKeywords(keywords: string[], options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const escaped = keywords.map(k => `"${k.replace(/"/g, '""')}"`).join(" OR ");
    const rows = this.withLevelFilter(escaped, options, limit * FETCH_MULTIPLIER) as DocChunkRow[];
    return this.dedupeByDocument(rows, limit);
  }

  /** FTS 查询 + 可选 level 过滤（动态 SQL；无过滤走预编译热路径）。 */
  private withLevelFilter(match: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    if (!options.level && !options.category) {
      return this.stmtSearchFts!.all(match, limit) as DocChunkRow[];
    }
    let sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source,
             c.content, c.char_count, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ? AND d.doc_type = 'law_article'
    `;
    const params: Array<string | number> = [match];
    if (options.level) {
      sql += " AND d.level = ?";
      params.push(options.level);
    }
    sql += " ORDER BY bm25(docs_fts) LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as DocChunkRow[];
  }

  private searchLike(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    if (!options.level) {
      return this.stmtSearchLike.all(pattern, pattern, limit) as DocChunkRow[];
    }
    let sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source, c.content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article'
        AND (d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')
    `;
    const params: Array<string | number> = [pattern, pattern];
    if (options.level) {
      sql += " AND d.level = ?";
      params.push(options.level);
    }
    sql += " ORDER BY d.char_count DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as DocChunkRow[];
  }

  /** 按文档去重（一文档一行，保留 bm25 最优 chunk——排序后首个出现的行）。 */
  private dedupeByDocument(rows: DocChunkRow[], limit: number): DocChunkRow[] {
    const seen = new Set<string>();
    const deduped: DocChunkRow[] = [];
    for (const row of rows) {
      if (seen.has(row.document_id)) continue;
      seen.add(row.document_id);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }
    return deduped;
  }

  private toRecord(row: DocChunkRow): LawRecord {
    return {
      id: row.document_id,
      level: row.level ?? "其他",
      name: row.title,
      expired: 0,
      categoryId: 0,
      content: row.content ?? undefined,
      categoryName: "法律法规",
    };
  }

  private toSearchResult(row: DocChunkRow): LawSearchResult {
    return { ...this.toRecord(row), score: row.fts_rank ?? 0 };
  }
}
