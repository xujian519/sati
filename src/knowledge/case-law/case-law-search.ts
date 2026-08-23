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
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";
import {
  escapeFtsPhrase,
  FTS_MIN_RUNES,
  joinFtsOrTerms,
  runFtsThenLikeFallback,
  sqliteHasFts5,
} from "../shared/fts.js";
import { decompressChunk, registerChunkUncompress } from "../shared/chunk-compression.js";
import { prepareCached } from "../../shared/sqlite.js";
import type { KnowledgeRuntimeStats } from "../shared/knowledge-stats.js";
import { extractLawKeywords } from "../legal/keywords.js";
import type { KnowledgeEmbeddingSearch } from "../shared/knowledge-embeddings.js";
import type { CaseLawChunk, CaseLawHit, CaseLawSearchOptions } from "./types.js";

/** 引擎构造选项（全部可选；不传时行为与旧签名完全一致）。 */
export type CaseLawSearchEngineOptions = {
  /** 降级/异常日志出口（不传时静默，与旧行为一致）。 */
  logger?: { warn: (message: string) => void };
  /** 运行时状态聚合（可观测性出口；降级时打点）。 */
  stats?: KnowledgeRuntimeStats;
  /**
   * LIKE 两阶段检索开关（默认 true，即读取 `SATI_LIKE_TWO_PHASE=0` 之外一律启用）。
   * 显式注入 false 回滚旧单阶段 SQL（UDF 在 SQL 中）；测试用。
   */
  likeTwoPhase?: boolean;
  /** 阶段 2 content 扫描的文档行数上限（默认 LIKE_SCAN_CAP=5000；测试可注入小值）。 */
  likeScanCap?: number;
};

/**
 * 每文档多 chunk 命中时的放大取数系数（供 JS 层按文档去重）。
 */
const FETCH_MULTIPLIER = 5;

/** 引擎层单次检索返回的判例上限（工具层另有更严格的 1-10 限制）。 */
const MAX_LIMIT = 50;

/**
 * LIKE 两阶段（P1）阶段 2 的 content 扫描行数上限：按 documents.id 升序只扫
 * 前 N 篇——罕见词无命中时旧单阶段 SQL 全表扫 8 万行（每行最长 chunk 子查询
 * + UDF 解压 ~4ms），最坏分钟级同步阻塞；受限扫描把上界压到亚秒级
 * （5000 × (点查 0.04ms + 解压 ~0.05ms) ≈ 0.5s 尾部延迟，命中提前退出）。
 * 截断时置 likeScanCapped 供工具层提示「仅扫描前 N 篇」。
 */
const LIKE_SCAN_CAP = 5000;

/** 是否存在会改变 SQL 形状的过滤条件（有过滤时走动态 SQL，低频）。 */
function hasCaseLawFilters(options: CaseLawSearchOptions): boolean {
  return Boolean(options.docType || options.court || options.excludeSource);
}

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
  /** 正文片段（LIKE/回源路径有值；FTS 主查询不取正文，经回源填充——延迟解压）。 */
  content: string | null;
  fts_rank?: number | null;
};

/** 判例语义召回源（由 gateway 注入：query 向量 + knowledge.db embeddings reader）。 */
export type CaseLawSemanticSource = {
  /** 生成查询向量（调用方提供 embedding client）。 */
  embed: (text: string) => Promise<Float32Array>;
  /** knowledge.db embeddings reader（docTypes 应为 case/judgment）。 */
  search: KnowledgeEmbeddingSearch;
};

/**
 * personal_note 语义召回源（结构化接口，避免与 personal-note 模块循环依赖）。
 * id 即 documents.id，供 searchSemantic 命中后经 stmtGetDocById 回源正文。
 */
export type PersonalNoteSemanticSource = {
  search(query: string, limit: number): Promise<Array<{ id: string; score: number }>>;
};

/**
 * 构造判例语义召回源：把 EmbeddingClient 的批量接口包装为单条 Float32Array。
 * 组装层（buildKnowledgeResolvers）与工具语义源注入（createLocalGateway）共用，
 * 避免 embed 闭包在多个位置重复。
 */
export function createCaseLawSemanticSource(
  embedBatch: (texts: string[]) => Promise<number[][]>,
  search: KnowledgeEmbeddingSearch,
): CaseLawSemanticSource {
  return {
    embed: async (text: string) => {
      const [vector] = await embedBatch([text]);
      return Float32Array.from(vector ?? []);
    },
    search,
  };
}

export class CaseLawSearchEngine {
  private readonly db: DatabaseSync;
  private readonly hasFts: boolean;
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  private ftsDegraded = false;
  private readonly logger?: { warn: (message: string) => void };
  private readonly stats?: KnowledgeRuntimeStats;
  /** LIKE 两阶段开关（env `SATI_LIKE_TWO_PHASE=0` 或构造注入 false 时回滚旧单阶段）。 */
  private readonly likeTwoPhase: boolean;
  /** 阶段 2 content 扫描行数上限（构造注入覆盖 LIKE_SCAN_CAP；测试用小值）。 */
  private readonly likeScanCap: number;
  /** 最近一次 LIKE 检索是否因扫描上限截断（likeScanCapped getter 读取）。 */
  private likeScanTruncated = false;

  // 热路径 prepared statements（固定 SQL；带过滤的查询走动态 SQL）
  private readonly stmtSearchLike: StatementSync;
  /** LIKE 阶段 1：documents.title 直查（无 JOIN、无 UDF；见 searchLikeTwoPhase）。 */
  private readonly stmtLikeTitle: StatementSync;
  private readonly stmtSearchFts: StatementSync | null;
  private readonly stmtGetById: StatementSync;
  private readonly stmtGetDocById: StatementSync;
  /** 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源，保持"命中 chunk"语义）。 */
  private readonly stmtGetChunkAt: StatementSync;
  private readonly stmtCount: StatementSync;

  /**
   * 动态 SQL（带过滤组合）的 prepare 缓存：同一 SQL 形状只 prepare 一次。
   * 过滤组合数量有界（docType/court/excludeSource 的布尔组合），Map 不会无限膨胀。
   */
  private readonly preparedCache = new Map<string, StatementSync>();

  /** 语义召回源（可选；gateway 注入后启用判例语义叠加）。 */
  private semantic?: CaseLawSemanticSource;

  /** personal_note 语义召回源（可选；组装层/工具侧注入后启用项目笔记语义叠加）。 */
  private noteSemantic?: PersonalNoteSemanticSource;

  constructor(dbPath: string, options: CaseLawSearchEngineOptions = {}) {
    this.logger = options.logger;
    this.stats = options.stats;
    // P1：两阶段默认开（env 显式 SATI_LIKE_TWO_PHASE=0 回滚旧单阶段 SQL）。
    this.likeTwoPhase = options.likeTwoPhase ?? process.env.SATI_LIKE_TWO_PHASE !== "0";
    this.likeScanCap = options.likeScanCap ?? LIKE_SCAN_CAP;
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    this.db = opened.db;
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(this.db);
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='docs_fts'")
      .get() as { c: number };
    // 双重条件才启用 FTS：docs_fts 表存在 + 运行时 SQLite 编译了 FTS5。
    this.hasFts = row.c > 0 && sqliteHasFts5(this.db);

    // LIKE 旧单阶段 SQL（searchLikeLegacy 回滚路径；P1 两阶段默认启用后仅
    // SATI_LIKE_TWO_PHASE=0 时使用）：documents.title 或 每文档最长 chunk 的
    // content（压缩 chunk 先经 UDF 解压再匹配）；子查询取最长 chunk 作片段。
    // ⚠️ 无命中全扫时每行 UDF 解压 ~4ms × 8 万行 = 分钟级同步阻塞（H2 卡点）。
    this.stmtSearchLike = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index,
             sati_uncompress(c.content) AS content
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
      LIMIT ?
    `);

    // LIKE 阶段 1：documents.title 直查（P1 两阶段主路径）。不 JOIN chunks、
    // 无 UDF——旧 SQL 的无命中全扫会被最长 chunk 子查询 + UDF 拖到分钟级；
    // title 直查全扫 ~100ms 尾部延迟可接受，命中靠 LIMIT 提前退出。片段留空
    // （content NULL），JS 层对 top-limit 回源最长 chunk（stmtGetDocById，
    // 与 FTS 路径 backfillContent 同模式）。
    this.stmtLikeTitle = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, NULL AS chunk_index, NULL AS content
      FROM documents d
      WHERE d.title LIKE ? ESCAPE '\\'
      LIMIT ?
    `);

    // 按 documents.id 取全文分块（供"查看判例全文"场景）。
    // 注：content 取原始存储（TEXT 明文 / SC 魔数 gzip BLOB），JS 层
    // decompressChunk 解压——绕开 node:sqlite JS UDF 的 ~4ms/次边界开销
    // （实测：UDF 单行 4.18ms vs 原始列 0.04ms）。
    this.stmtGetById = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index,
             c.content AS content
      FROM documents d
      JOIN chunks c ON c.document_id = d.id
      WHERE d.id = ?
      ORDER BY c.chunk_index
    `);

    // 按 documents.id 取最长 chunk（语义命中回源片段）。
    this.stmtGetDocById = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index,
             c.content AS content
      FROM documents d
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
      WHERE d.id = ?
    `);

    // 按 (document_id, chunk_index) 取命中 chunk（FTS 延迟解压回源；保持
    // 旧行为"片段 = 命中的 chunk"而非最长 chunk）。
    this.stmtGetChunkAt = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count, c.chunk_index,
             c.content AS content
      FROM documents d
      JOIN chunks c ON c.document_id = d.id AND c.chunk_index = ?
      WHERE d.id = ?
    `);

    // 无过滤 FTS 查询（searchFts 与 searchFtsKeywords 的 SQL 相同，仅 MATCH 参数
    // 不同，共用一条语句）。docs_fts 表可能存在但运行时 SQLite 未注册 FTS5
    // （如捆绑旧版 Node 的 bm25/MATCH），prepare 会抛错——捕获并降级 LIKE。
    // 正文不在此取（sati_uncompress 延迟到 JS 层对 top-N 回源——避免解压
    // FETCH_MULTIPLIER×limit 行全文）。排序保持 bm25(docs_fts)：实测 JOIN 场景
    // ORDER BY rank 触发 FTS5 rank 全量物化（354ms vs bm25 0.12ms，3000 倍倒退）
    // ——rank 渐进优化仅适用无 JOIN 的 FTS 直查（H5 实测证伪，勿改回 rank）。
    this.stmtSearchFts = null;
    if (this.hasFts) {
      try {
        this.stmtSearchFts = this.db.prepare(`
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count,
             c.chunk_index, NULL AS content, bm25(docs_fts) AS fts_rank
      FROM docs_fts
      JOIN chunks c ON c.id = docs_fts.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE docs_fts MATCH ?
      ORDER BY bm25(docs_fts) LIMIT ?
    `);
      } catch (error) {
        this.degradeFts(error instanceof Error ? error.message : String(error));
        this.stmtSearchFts = null;
      }
    }

    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM documents");
  }

  /** 注入判例语义召回源（gateway 启动时；未注入时语义路关闭）。 */
  setSemantic(source?: CaseLawSemanticSource): void {
    this.semantic = source;
  }

  /** 注入 personal_note 语义召回源（未注入时该路关闭）。 */
  setNoteSemantic(source?: PersonalNoteSemanticSource): void {
    this.noteSemantic = source;
  }

  /** FTS5 粘性降级打点（构造期 prepare 捕获与查询期异常共用）。 */
  private degradeFts(reason: string): void {
    this.ftsDegraded = true;
    this.logger?.warn?.(`[sati] case-law FTS5 不可用，已降级 LIKE: ${reason}`);
    this.stats?.setCaseLawFtsDegraded(true);
  }

  /** 语义召回源是否就绪（判例语义或 personal_note 语义任一可用）。 */
  get semanticAvailable(): boolean {
    return this.semantic?.search.available === true || this.noteSemantic !== undefined;
  }

  /**
   * 语义召回：判例语义（knowledge.db embeddings case/judgment）+ personal_note
   * 语义（项目沉淀笔记）双路叠加，命中均按 documents.id 回源最长 chunk 片段。
   * 任一路失败降级跳过，不阻断另一路与关键词路。
   */
  async searchSemantic(keyword: string, limit: number): Promise<CaseLawHit[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const results: CaseLawHit[] = [];
    const seen = new Set<string>();

    // 1. 判例语义：embed query → top-k → 回源。
    //    ready 检查（P4 异步预热）：矩阵未加载时跳过语义路——省一次 embed API
    //    调用（embed 结果对空矩阵毫无意义），关键词路不受影响。
    //    #9b 死门修复：未 ready 时经 tryWarm 保持预热通道——gateway 的一次性
    //    预热失败后，由后续语义查询按冷却期（backoff）重试，语义路不永久死亡。
    const source = this.semantic;
    if (source && source.search.available) {
      if (!source.search.ready) {
        source.search.tryWarm();
      } else {
        try {
          const queryVector = await source.embed(trimmed);
          if (queryVector.length > 0) {
            for (const hit of source.search.search(queryVector, limit)) {
              if (results.length >= limit) break;
              const row = this.stmtGetDocById.get(hit.docId) as CaseLawRow | undefined;
              if (!row || seen.has(row.document_id)) continue;
              seen.add(row.document_id);
              results.push(this.toHit(row, null, "semantic"));
            }
          }
        } catch (error) {
          // 判例语义路失败降级（不阻断 personal_note 路与关键词路）。
          this.logger?.warn?.(
            `[sati] 判例语义召回失败，降级跳过: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // 2. personal_note 语义：项目沉淀笔记（OA 答复要点等），命中经同一语句回源。
    if (this.noteSemantic && results.length < limit) {
      try {
        for (const hit of await this.noteSemantic.search(trimmed, limit)) {
          if (results.length >= limit) break;
          if (seen.has(hit.id)) continue;
          const row = this.stmtGetDocById.get(hit.id) as CaseLawRow | undefined;
          if (!row) continue;
          seen.add(hit.id);
          results.push(this.toHit(row, null, "semantic"));
        }
      } catch (error) {
        // personal_note 语义失败降级（embedding 端点不可用等），不阻断。
        this.logger?.warn?.(
          `[sati] personal_note 语义召回失败，降级跳过: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return results;
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded;
  }

  /** 判例全文搜索：FTS5 BM25 优先，短查询/无 FTS 时降级 LIKE；结果按文档去重（一文档一行）。 */
  search(keyword: string, options: CaseLawSearchOptions = {}): CaseLawHit[] {
    // 每次检索入口清零截断信号：FTS/legacy/异常路径不再残留上次 LIKE 扫描的
    // 旧值（likeScanCapped getter 语义 = 「本次 search 是否截断」）。
    this.likeScanTruncated = false;
    const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_LIMIT);
    return runFtsThenLikeFallback<CaseLawHit>({
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
  }

  /** 按 documents.id 取判例全文分块（供"查看全文"场景；不经过检索，无 via/ftsRank 语义）。 */
  getById(documentId: string): CaseLawChunk[] {
    const rows = this.stmtGetById.all(documentId) as CaseLawRow[];
    return rows.map(row => ({
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: decompressChunk(row.content),
    }));
  }

  /** 统计判例文档总数（诊断用）。 */
  count(): number {
    const row = this.stmtCount.get() as { c: number };
    return row.c;
  }

  close(): void {
    this.preparedCache.clear();
    this.db.close();
  }

  /** 构建 FTS 查询（固定投影 + 可选过滤；带过滤时拼接动态 SQL）。 */
  private buildFtsQuery(options: CaseLawSearchOptions): { sql: string; filterParams: Array<string | null> } {
    let sql = `
      SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
             d.court, d.source, d.module, d.char_count,
             c.chunk_index, NULL AS content, bm25(docs_fts) AS fts_rank
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
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit);
  }

  /** 多个关键词 OR 组合的 FTS 查询（用于长查询切词降级）。 */
  private searchFtsKeywords(keywords: string[], options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit);
  }

  private searchFtsWithQuery(query: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    let rows: CaseLawRow[];
    if (this.stmtSearchFts !== null && !hasCaseLawFilters(options)) {
      rows = this.stmtSearchFts.all(query, limit * FETCH_MULTIPLIER) as CaseLawRow[];
    } else {
      const { sql, filterParams } = this.buildFtsQuery(options);
      rows = prepareCached(this.preparedCache, this.db, sql).all(
        query,
        ...filterParams,
        limit * FETCH_MULTIPLIER,
      ) as CaseLawRow[];
    }
    return this.backfillContent(this.dedupeByDocument(rows, limit));
  }

  /**
   * 延迟解压回源：FTS 主查询不取正文（避免解压 FETCH_MULTIPLIER×limit 行全文），
   * 去重后仅对最终 top-limit 行按 (document_id, chunk_index) 回源**命中 chunk**
   * 片段——保持旧行为"片段 = 命中的 chunk"；JS 层解压（绕开 UDF 边界开销）。
   */
  private backfillContent(hits: CaseLawHit[]): CaseLawHit[] {
    return hits.map(hit => {
      if (hit.snippet) return hit;
      const row = this.stmtGetChunkAt.get(hit.chunkIndex, hit.documentId) as CaseLawRow | undefined;
      return row ? { ...hit, snippet: decompressChunk(row.content) } : hit;
    });
  }

  /**
   * LIKE 查询过滤子句（阶段 1/2 共用；与 buildFtsQuery 的过滤条件同构，
   * 复用 preparedCache 的形状去重）。返回裸子句，由调用方决定前缀：
   * 阶段 1 已有 WHERE（title 条件）→ ` AND ${join}`；阶段 2 无 WHERE → ` WHERE ${join}`。
   */
  private buildLikeClauses(options: CaseLawSearchOptions): { clauses: string[]; params: Array<string | null> } {
    const clauses: string[] = [];
    const params: Array<string | null> = [];
    if (options.docType) {
      clauses.push("d.doc_type = ?");
      params.push(options.docType);
    }
    if (options.court) {
      clauses.push("d.court LIKE ?");
      params.push(`%${options.court.replace(/[%_\\]/g, m => `\\${m}`)}%`);
    }
    if (options.excludeSource) {
      clauses.push("d.source != ?");
      params.push(options.excludeSource);
    }
    return { clauses, params };
  }

  /** LIKE 降级入口：两阶段默认开；SATI_LIKE_TWO_PHASE=0 / 构造注入 false 时走旧单阶段。 */
  private searchLike(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    // LIKE 回退计数（设计内降级路径：短词/未命中/FTS 降级；不 warn 避免噪音）。
    this.stats?.recordLikeFallback();
    try {
      return this.likeTwoPhase
        ? this.searchLikeTwoPhase(keyword, options, limit)
        : this.searchLikeLegacy(keyword, options, limit);
    } catch (error) {
      // SQLite LIKE 模式长度上限（默认 50000 字节）——超长查询串（如整篇文书
      // 粘贴）执行时抛 "LIKE or GLOB pattern too complex"。降级返回空结果
      // 而非中断检索：语义路（searchSemantic）独立于此方法仍可召回，关键词
      // 路也不会让整个检索流程崩溃。
      if (/pattern too complex/i.test(error instanceof Error ? error.message : String(error))) {
        this.logger?.warn?.(
          `[sati] case-law LIKE 模式超限（${Array.from(keyword).length} 字），降级空结果: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      }
      throw error;
    }
  }

  /**
   * LIKE 两阶段降级（P1，2026-08）：UDF 不出现在 SQL——旧单阶段每行
   * sati_uncompress 解压（4.18ms/行 × 8 万行，罕见词最坏分钟级同步阻塞）。
   *   阶段 1：documents.title 直查（无 JOIN 无 UDF；title 全扫 ~100ms 尾部
   *           延迟可接受，命中靠 LIMIT 提前退出）。命中行 snippet 由 JS 层对
   *           top-limit 回源最长 chunk（stmtGetDocById，与 FTS backfillContent
   *           同模式），保持旧语义「片段 = 最长 chunk」。
   *   阶段 2（title 不足 limit 且 runes ≥ 2）：documents 直查候选（按 rowid
   *           升序，上限 likeScanCap 篇），JS 侧 decompressChunk + 双端小写
   *           字面匹配（等价旧 LIKE 转义语义）。1 字查询只走阶段 1——1 字
   *           content 全扫是分钟级卡点，设计内牺牲 content 召回（title 命中保留）；
   *           2 字及以上放行受限扫描（cap 兜底，可接受）。
   *   截断信号：likeScanCapped getter 供工具层提示「仅扫描前 N 篇」。
   *   顺序差异属预期变化：阶段 1 行序（SQLite 自然序）+ 阶段 2 按 id 升序，
   *   不再是旧 SQL 的文档内自然序。
   */
  private searchLikeTwoPhase(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;

    // 阶段 1：title 直查
    let rows: CaseLawRow[];
    if (!hasCaseLawFilters(options)) {
      rows = this.stmtLikeTitle.all(pattern, limit) as CaseLawRow[];
    } else {
      const { clauses, params } = this.buildLikeClauses(options);
      const sql = `
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, NULL AS chunk_index, NULL AS content
        FROM documents d
        WHERE d.title LIKE ? ESCAPE '\\'${clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : ""}
        LIMIT ?
      `;
      rows = prepareCached(this.preparedCache, this.db, sql).all(pattern, ...params, limit) as CaseLawRow[];
    }
    // title 直查不 JOIN chunks → 逐行回源最长 chunk 作片段（点查 ~0.04ms/行 × limit ≤ 50，
    // 保持旧语义「片段 = 最长 chunk」；文档异常缺失时回落空 snippet 不阻断）。
    const hits = rows.map(row => {
      const full = this.stmtGetDocById.get(row.document_id) as CaseLawRow | undefined;
      return this.toHit(full ?? row, null, "like");
    });

    // 阶段 2：受限 content 扫描（title 不足 limit 且 ≥2 字；1 字只走阶段 1）
    if (hits.length < limit && Array.from(keyword).length >= 2) {
      const seen = new Set(rows.map(row => row.document_id));
      const { clauses, params } = this.buildLikeClauses(options);
      const sql = `
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, NULL AS chunk_index, NULL AS content
        FROM documents d${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY d.rowid
        LIMIT ?
      `;
      const candidates = prepareCached(this.preparedCache, this.db, sql).all(
        ...params,
        this.likeScanCap,
      ) as CaseLawRow[];
      this.likeScanTruncated = candidates.length >= this.likeScanCap;
      // 双端小写后字面匹配：旧 LIKE 语义大小写不敏感，JS includes 是大小写敏感的
      // ——大写查询（如「ABC 公司」）会漏掉小写正文（#4b）。
      const needle = keyword.toLowerCase();
      for (const row of candidates) {
        if (hits.length >= limit) break;
        if (seen.has(row.document_id)) continue;
        const full = this.stmtGetDocById.get(row.document_id) as CaseLawRow | undefined;
        if (!full) continue;
        if (decompressChunk(full.content).toLowerCase().includes(needle)) {
          seen.add(row.document_id);
          hits.push(this.toHit(full, null, "like"));
        }
      }
    }

    return hits;
  }

  /** 旧单阶段 LIKE（SATI_LIKE_TWO_PHASE=0 回滚路径）：UDF 在 SQL 中解压最长 chunk。 */
  private searchLikeLegacy(keyword: string, options: CaseLawSearchOptions, limit: number): CaseLawHit[] {
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    let rows: CaseLawRow[];
    if (!hasCaseLawFilters(options)) {
      rows = this.stmtSearchLike.all(pattern, pattern, limit) as CaseLawRow[];
    } else {
      let sql = `
        SELECT d.id AS document_id, d.doc_type, d.title, d.decision_number, d.case_number,
               d.court, d.source, d.module, d.char_count, c.chunk_index,
               sati_uncompress(c.content) AS content
        FROM documents d
        JOIN chunks c ON c.id = (
          SELECT id FROM chunks WHERE document_id = d.id ORDER BY char_count DESC LIMIT 1)
        WHERE (d.title LIKE ? ESCAPE '\\' OR sati_uncompress(c.content) LIKE ? ESCAPE '\\')
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
      rows = prepareCached(this.preparedCache, this.db, sql).all(...params) as CaseLawRow[];
    }
    return rows.map(row => this.toHit(row, null, "like"));
  }

  /** 最近一次 LIKE 检索是否因阶段 2 扫描上限截断（供工具层提示「仅扫描前 N 篇」）。 */
  get likeScanCapped(): boolean {
    return this.likeScanTruncated;
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

  private toHit(row: CaseLawRow, ftsRank: number | null, via: CaseLawHit["via"]): CaseLawHit {
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
      snippet: decompressChunk(row.content),
      ftsRank,
      via,
    };
  }
}
