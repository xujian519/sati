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
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";
import { prepareCached } from "../../shared/sqlite.js";
import {
  escapeFtsPhrase,
  FTS_MIN_RUNES,
  joinFtsOrTerms,
  runFtsThenLikeFallback,
  sqliteHasFts5,
} from "../shared/fts.js";
import { decompressChunk, registerChunkUncompress } from "../shared/chunk-compression.js";
import type { KnowledgeRuntimeStats } from "../shared/knowledge-stats.js";
import type { LawCategory, LawRecord, LawSearchResult, LegalSearchSource } from "./types.js";
import { extractLawKeywords } from "./keywords.js";

/** 引擎构造选项（全部可选；不传时行为与旧签名完全一致）。 */
export type KnowledgeLawSearchOptions2 = {
  /** 降级/异常日志出口（不传时静默，与旧行为一致）。 */
  logger?: { warn: (message: string) => void };
  /** 运行时状态聚合（可观测性出口；降级时打点）。 */
  stats?: KnowledgeRuntimeStats;
};

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
  /** 正文片段（LIKE/回源路径有值；FTS 主查询不取正文，经回源填充——延迟解压）。 */
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
  private readonly logger?: { warn: (message: string) => void };
  private readonly stats?: KnowledgeRuntimeStats;

  private readonly stmtSearchLike: StatementSync;
  private readonly stmtSearchFts: StatementSync | null;
  private readonly stmtFindByName: StatementSync;
  private readonly stmtGetById: StatementSync;
  /** 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源，保持"命中 chunk"语义）。 */
  private readonly stmtGetChunkAt: StatementSync;
  private readonly stmtCount: StatementSync;
  /** 动态 SQL（带过滤组合）prepare 缓存：同形状 SQL 复用 StatementSync。 */
  private readonly preparedCache = new Map<string, StatementSync>();

  constructor(dbPath: string, options: KnowledgeLawSearchOptions2 = {}) {
    this.logger = options.logger;
    this.stats = options.stats;
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    this.db = opened.db;
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(this.db);
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'")
      .get() as { c: number };
    this.hasFts = row.c > 0 && sqliteHasFts5(this.db);

    // LIKE 降级：documents.title 或每文档最长 chunk 的 content（压缩 chunk 先
    // 解压再匹配）；子查询取最长 chunk 作片段。content 取原始存储（TEXT 明文 /
    // SC 魔数 gzip BLOB），JS 层 decompressChunk 解压——绕开 node:sqlite JS UDF
    // 的 ~4ms/次边界开销；WHERE 的 sati_uncompress 仅匹配语义（LIKE 降级路径低频）。
    this.stmtSearchLike = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source,
             c.content AS content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article'
        AND (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
      ORDER BY d.char_count DESC LIMIT ?
    `);
    // 正文不在此取（sati_uncompress 延迟到 JS 层对 top-N 回源——避免解压
    // FETCH_MULTIPLIER×limit 行全文）。排序保持 bm25(docs_fts)：实测 JOIN 场景
    // ORDER BY rank 触发 FTS5 rank 全量物化（354ms vs bm25 0.12ms，3000 倍倒退）
    // ——rank 渐进优化仅适用无 JOIN 的 FTS 直查（H5 实测证伪，勿改回 rank）。
    this.stmtSearchFts = null;
    if (this.hasFts) {
      try {
        this.stmtSearchFts = this.db.prepare(`
          SELECT d.id AS document_id, d.title, d.level, d.source,
                 NULL AS content, c.chunk_index, c.char_count, bm25(docs_fts) AS fts_rank
          FROM docs_fts
          JOIN chunks c ON c.id = docs_fts.rowid
          JOIN documents d ON d.id = c.document_id
          WHERE docs_fts MATCH ? AND d.doc_type = 'law_article'
          ORDER BY bm25(docs_fts) LIMIT ?
        `);
      } catch (error) {
        this.degradeFts(error instanceof Error ? error.message : String(error));
        this.stmtSearchFts = null;
      }
    }
    this.stmtFindByName = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source,
             c.content AS content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article' AND d.title LIKE ? ESCAPE '\\'
      LIMIT ?
    `);
    this.stmtGetById = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source,
             c.content AS content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.id = ?
    `);
    // 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源）。
    this.stmtGetChunkAt = this.db.prepare(`
      SELECT d.id AS document_id, d.title, d.level, d.source,
             c.content AS content, c.char_count
      FROM documents d
      JOIN chunks c ON c.document_id = d.id AND c.chunk_index = ?
      WHERE d.id = ?
    `);
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = 'law_article'");
  }

  /** FTS5 粘性降级打点（构造期 prepare 捕获与查询期异常共用）。 */
  private degradeFts(reason: string): void {
    this.ftsDegraded = true;
    this.logger?.warn?.(`[sati] 法规 FTS5 不可用，已降级 LIKE: ${reason}`);
    this.stats?.setLegalFtsDegraded(true);
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded;
  }

  /** 法规全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；按文档去重。 */
  search(keyword: string, options: KnowledgeLawSearchOptions = {}): LawSearchResult[] {
    const limit = options.limit ?? 10;
    const rows = runFtsThenLikeFallback<DocChunkRow>({
      useFts: this.ftsAvailable,
      minRunes: FTS_MIN_RUNES,
      keyword,
      limit,
      searchFts: (k, l) => this.searchFts(k, options, l),
      searchFtsKeywords: (kw, l) => this.searchFtsKeywords(kw, options, l),
      searchLike: (k, l) => this.searchLike(k, options, l),
      extractKeywords: extractLawKeywords,
      onDegrade: msg => this.degradeFts(msg),
    });

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
    const unique = Array.from(new Set(ids.filter(id => id.length > 0)));
    if (unique.length === 0) return [];
    if (unique.length === 1) {
      const record = this.getById(unique[0]!);
      return record ? [record] : [];
    }
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT d.id AS document_id, d.title, d.level, d.source,
               c.content AS content, c.char_count
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
    this.preparedCache.clear();
    this.db.close();
  }

  private searchFts(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit);
  }

  private searchFtsKeywords(keywords: string[], options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit);
  }

  private searchFtsWithQuery(query: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    const rows = this.withLevelFilter(query, options, limit * FETCH_MULTIPLIER) as DocChunkRow[];
    return this.backfillContent(this.dedupeByDocument(rows, limit));
  }

  /**
   * 延迟解压回源：FTS 主查询不取正文（避免解压 FETCH_MULTIPLIER×limit 行全文），
   * 去重后仅对最终 top-limit 行按 (document_id, chunk_index) 回源**命中 chunk**
   * 片段（含解压）——保持旧行为"片段 = 命中的 chunk"。
   */
  private backfillContent(rows: DocChunkRow[]): DocChunkRow[] {
    return rows.map(row => {
      if (row.content !== null) return row;
      const hit = this.stmtGetChunkAt.get(row.chunk_index, row.document_id) as DocChunkRow | undefined;
      return hit ? { ...row, content: decompressChunk(hit.content) } : row;
    });
  }

  /** FTS 查询 + 可选 level 过滤（动态 SQL；无过滤走预编译热路径）。 */
  private withLevelFilter(match: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    if (!options.level) {
      return this.stmtSearchFts!.all(match, limit) as DocChunkRow[];
    }
    const sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source,
             NULL AS content, c.chunk_index, c.char_count, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ? AND d.doc_type = 'law_article' AND d.level = ?
      ORDER BY bm25(docs_fts) LIMIT ?
    `;
    return prepareCached(this.preparedCache, this.db, sql).all(match, options.level, limit) as DocChunkRow[];
  }

  private searchLike(keyword: string, options: KnowledgeLawSearchOptions, limit: number): DocChunkRow[] {
    // LIKE 回退计数（设计内降级路径：短词/未命中/FTS 降级；不 warn 避免噪音）。
    this.stats?.recordLikeFallback();
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    if (!options.level) {
      return this.stmtSearchLike.all(pattern, pattern, limit) as DocChunkRow[];
    }
    let sql = `
      SELECT d.id AS document_id, d.title, d.level, d.source,
             sati_uncompress(c.content) AS content, c.char_count
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.doc_type = 'law_article'
        AND (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
    `;
    const params: Array<string | number> = [pattern, pattern];
    if (options.level) {
      sql += " AND d.level = ?";
      params.push(options.level);
    }
    sql += " ORDER BY d.char_count DESC LIMIT ?";
    params.push(limit);
    return prepareCached(this.preparedCache, this.db, sql).all(...params) as DocChunkRow[];
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
    const content = decompressChunk(row.content);
    return {
      id: row.document_id,
      level: row.level ?? "其他",
      name: row.title,
      expired: 0,
      categoryId: 0,
      content: content.length > 0 ? content : undefined,
      categoryName: "法律法规",
    };
  }

  private toSearchResult(row: DocChunkRow): LawSearchResult {
    return { ...this.toRecord(row), score: row.fts_rank ?? 0 };
  }
}
