/**
 * 判例全文检索引擎（基于外接 knowledge.db）。
 *
 * 与 LegalSearchEngine（法条检索）同策略：FTS5（trigram tokenizer，BM25 排序）优先，
 * 短查询（< 3 个 CJK 字符）或缺失 FTS 表时降级 LIKE 匹配。
 *
 * 数据映射（已验证）：docs_fts 为 contentless FTS5（content=''，tokenize=trigram），
 * 其 rowid 即 chunks.id（144,069/144,178 命中 99.9%），正文必须经
 * `JOIN chunks c ON c.id = docs_fts.rowid` 再 `JOIN documents d ON d.id = c.document_id` 回源。
 *
 * FTS5 能力探测：docs_fts 表存在**且**运行时的 SQLite 编译了 FTS5 才走 FTS 路径。
 * 桌面端捆绑的旧版 Node（node:sqlite 未编译 FTS5，如 v22.14.0）即便表存在，
 * MATCH 查询也会抛 "no such module: fts5"——此时整体降级 LIKE，避免工具执行崩溃。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { FTS_MIN_RUNES, sqliteHasFts5 } from "../shared/fts.js";
import { extractLawKeywords } from "../legal/legal-search.js";
import type { CaseLawChunk, CaseLawHit, CaseLawSearchOptions } from "./types.js";

/**
 * 每文档多 chunk 命中时的放大取数系数（供 JS 层按文档去重）。
 */
const FETCH_MULTIPLIER = 5;

/** 引擎层单次检索返回的判例上限（工具层另有更严格的 1-10 限制）。 */
const MAX_LIMIT = 50;

type CaseLawRow = {
  document_id: string;
  doc_type: string;
  title: string;
  decision_number: string | null;
  case_number: string | null;
  court: string | null;
  source: string | null;
  module: string | null;
  char_count: number;
  chunk_index: number;
  content: string;
  fts_rank?: number | null;
};

export class CaseLawSearchEngine {
  private readonly db: DatabaseSync;
  private readonly hasFts: boolean;
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  private ftsDegraded = false;

  // 热路径 prepared statements（固定 SQL；带过滤的查询走动态 SQL）
  private readonly stmtSearchLike: StatementSync;
  private readonly stmtGetById: StatementSync;
  private readonly stmtCount: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'")
      .get() as { c: number };
    // 双重条件才启用 FTS：docs_fts 表存在 + 运行时 SQLite 编译了 FTS5。
    this.hasFts = row.c > 0 && sqliteHasFts5(this.db);

    // LIKE 降级：documents.title 或 每文档最长 chunk 的 content；子查询取最长 chunk 作片段。
    this.stmtSearchLike = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index, c.content
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE (d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')
      LIMIT ?
    `);

    // 按 documents.id 取全文分块（供"查看判例全文"场景）。
    this.stmtGetById = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index, c.content
      FROM documents d
      JOIN chunks c ON c.document_id = d.id
      WHERE d.id = ?
      ORDER BY c.chunk_index
    `);

    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM documents");
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded;
  }

  /** 判例全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；结果按文档去重（一文档一行）。 */
  search(keyword: string, options: CaseLawSearchOptions = {}): CaseLawHit[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_LIMIT);
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const runes = Array.from(trimmed);
    let hits: CaseLawHit[];
    if (!this.hasFts || this.ftsDegraded || runes.length < FTS_MIN_RUNES) {
      hits = this.searchLike(trimmed, options, limit);
    } else {
      try {
        // 1. 整句 phrase（短查询命中率高）
        hits = this.searchFts(trimmed, options, limit);
        // 2. 整句无命中时切词 OR 查询（长句/自然语言查询）
        if (hits.length === 0) {
          const keywords = extractLawKeywords(trimmed);
          if (keywords.length > 0 && keywords[0] !== trimmed) {
            hits = this.searchFtsKeywords(keywords, options, limit);
          }
        }
        // 3. FTS 仍无命中时降级 LIKE
        if (hits.length === 0) {
          hits = this.searchLike(trimmed, options, limit);
        }
      } catch {
        // FTS5 模块缺失或查询异常（如运行时 SQLite 未编译 FTS5，MATCH 抛
        // "no such module: fts5"）：整体降级 LIKE，避免工具执行崩溃。
        this.ftsDegraded = true;
        hits = this.searchLike(trimmed, options, limit);
      }
    }
    return hits;
  }

  /** 按 documents.id 取判例全文分块（供"查看全文"场景；不经过检索，无 via/ftsRank 语义）。 */
  getById(documentId: string): CaseLawChunk[] {
    const rows = this.stmtGetById.all(documentId) as CaseLawRow[];
    return rows.map(row => ({
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
    }));
  }

  /** 统计判例文档总数（诊断用）。 */
  count(): number {
    const row = this.stmtCount.get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }

  /** 构建 FTS 查询（固定投影 + 可选过滤；带过滤时拼接动态 SQL）。 */
  private buildFtsQuery(options: CaseLawSearchOptions): { sql: string; filterParams: Array<string | null> } {
    let sql = `
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count,
             c.chunk_index, c.content, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ?
    `;
    const filterParams: Array<string | null> = [];
    if (options.docType) {
      sql += " AND d.doc_type = ?";
      filterParams.push(options.docType);
    }
    if (options.court) {
      sql += " AND d.court LIKE ?";
      filterParams.push(`%${options.court.replace(/[%_\\]/g, m => `\\${m}`)}%`);
    }
    if (options.excludeSource) {
      sql += " AND d.source != ?";
      filterParams.push(options.excludeSource);
    }
    sql += " ORDER BY bm25(docs_fts) LIMIT ?";
    return { sql, filterParams };
  }

  private searchFts(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    // trigram 分词对引号敏感：整体作为 phrase 查询（与 law_fts 同策略）。
    const escaped = keyword.replace(/"/g, '""');
    const { sql, filterParams } = this.buildFtsQuery(options);
    const rows = this.db.prepare(sql).all(`"${escaped}"`, ...filterParams, limit * FETCH_MULTIPLIER) as CaseLawRow[];
    return this.dedupeByDocument(rows, limit);
  }

  /** 多个关键词 OR 组合的 FTS 查询（用于长查询切词降级）。 */
  private searchFtsKeywords(keywords: string[], options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    const escaped = keywords.map(k => `"${k.replace(/"/g, '""')}"`).join(" OR ");
    const { sql, filterParams } = this.buildFtsQuery(options);
    const rows = this.db.prepare(sql).all(escaped, ...filterParams, limit * FETCH_MULTIPLIER) as CaseLawRow[];
    return this.dedupeByDocument(rows, limit);
  }

  private searchLike(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    let sql = `
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index, c.content
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE (d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')
    `;
    const params: Array<string | number | null> = [pattern, pattern];
    if (options.docType) {
      sql += " AND d.doc_type = ?";
      params.push(options.docType);
    }
    if (options.court) {
      sql += " AND d.court LIKE ?";
      params.push(`%${options.court.replace(/[%_\\]/g, m => `\\${m}`)}%`);
    }
    if (options.excludeSource) {
      sql += " AND d.source != ?";
      params.push(options.excludeSource);
    }
    sql += " LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as CaseLawRow[];
    return rows.map(row => this.toHit(row, null, "like"));
  }

  /** 同一文档多 chunk 命中时按文档去重，保留 bm25 最高 chunk（一文档一行）。 */
  private dedupeByDocument(rows: CaseLawRow[], limit: number): CaseLawHit[] {
    const bestByDoc = new Map<string, CaseLawRow>();
    for (const row of rows) {
      const best = bestByDoc.get(row.document_id);
      if (!best || (row.fts_rank ?? 0) > (best.fts_rank ?? 0)) {
        bestByDoc.set(row.document_id, row);
      }
    }
    const sorted = Array.from(bestByDoc.values()).sort((a, b) => (b.fts_rank ?? 0) - (a.fts_rank ?? 0));
    return sorted.slice(0, limit).map(row => this.toHit(row, row.fts_rank ?? null, "fts"));
  }

  private toHit(row: CaseLawRow, ftsRank: number | null, via: "fts" | "like"): CaseLawHit {
    return {
      documentId: row.document_id,
      docType: row.doc_type,
      title: row.title,
      decisionNumber: row.decision_number ?? undefined,
      caseNumber: row.case_number ?? undefined,
      court: row.court ?? undefined,
      source: row.source ?? undefined,
      module: row.module ?? undefined,
      charCount: row.char_count,
      chunkIndex: row.chunk_index,
      snippet: row.content,
      ftsRank,
      via,
    };
  }
}
