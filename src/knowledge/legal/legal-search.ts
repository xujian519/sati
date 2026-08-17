import { DatabaseSync, type StatementSync } from "node:sqlite";
import { openKnowledgeDb } from "../shared/db-version.js";
import { LAWS_DB } from "../shared/schema-versions.js";
import { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sqliteHasFts5 } from "../shared/fts.js";
import type { LawCategory, LawRecord, LawSearchResult, LegalSearchSource } from "./types.js";
import { extractLawKeywords } from "./keywords.js";
import { buildLawSearchSql, LAW_SEARCH_COLUMNS, LAW_SEARCH_COLUMNS_FTS } from "./sql.js";
import { dedupeByLawName } from "./dedupe.js";
import { toRecord, toSearchResult, type LawRow } from "./row-mapper.js";

export { extractLawKeywords } from "./keywords.js";

/**
 * 法律全文搜索引擎（基于宝宸知识库 laws-full-local.db / laws-full.db）。
 *
 * 与 Mady `SearchLaws` 同策略：FTS5（trigram tokenizer，BM25 排序）优先，
 * 短查询（< 3 个 CJK 字符）或缺失 FTS 表时降级 LIKE 匹配。
 * 注意：law_fts 的 rowid 对应 law 表的**隐藏 rowid**（非 law.id 主键）。
 *
 * FTS5 能力探测：law_fts 表存在**且**运行时的 SQLite 编译了 FTS5 才走 FTS 路径
 * （见 shared/fts.ts 的 sqliteHasFts5）。桌面端捆绑的旧版 Node（node:sqlite
 * 未编译 FTS5，如 v22.14.0）即便表存在，MATCH 查询也会抛 "no such module: fts5"——
 * 此时整体降级 LIKE，避免工具执行崩溃。
 */

/** 长查询切词（extractLawKeywords 见 ./keywords.ts，被 case-law/knowledge-law 跨域复用）。 */

export type LegalSearchOptions = {
  /** 返回条数上限（默认 10）。 */
  limit?: number;
  /** 按法律层级过滤（法律/行政法规/司法解释/地方性法规/宪法/案例/部门规章）。 */
  level?: string;
  /** 按分类名称过滤（如 专利法 所属的 民法商法）。 */
  category?: string;
};

export class LegalSearchEngine implements LegalSearchSource {
  private readonly db: DatabaseSync;
  private readonly hasFts: boolean;
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  private ftsDegraded = false;

  // 热路径 prepared statements（prepare 一次反复复用）
  private readonly stmtSearchLike: StatementSync;
  private readonly stmtSearchFts: StatementSync | null;
  private readonly stmtFindByName: StatementSync;
  private readonly stmtGetById: StatementSync;
  private readonly stmtGetCategories: StatementSync;
  private readonly stmtCount: StatementSync;

  constructor(dbPath: string) {
    const opened = openKnowledgeDb(dbPath, LAWS_DB, { readOnly: true });
    this.db = opened.db;
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='law_fts'")
      .get() as { c: number };
    // 双重条件才启用 FTS：law_fts 表存在 + 运行时 SQLite 编译了 FTS5。
    this.hasFts = row.c > 0 && sqliteHasFts5(this.db);

    // 基础（无 level/category 过滤）版本，热路径上避免逐次 prepare；
    // 带过滤条件的查询仍走动态 SQL（调用频率低）。
    this.stmtSearchLike = this.db.prepare(`
      SELECT ${LAW_SEARCH_COLUMNS}
      FROM law l
      JOIN category c ON c.id = l.category_id
      WHERE (l.name LIKE ? ESCAPE '\\' OR l.content LIKE ? ESCAPE '\\')
        AND (l.expired = 0 OR l.expired IS NULL)
      ORDER BY l.publish DESC, l."order" LIMIT ?
    `);
    // law_fts 表可能存在但运行时 SQLite 未注册 FTS5（如捆绑旧版 Node 的 bm25/MATCH），
    // prepare 会抛错——此处捕获并直接降级 LIKE（等价于原实现查询时的 catch 降级，行为不变）。
    // 注：searchFts 与 searchFtsKeywords 的 SQL 完全相同，共用同一条语句（仅参数不同）。
    this.stmtSearchFts = null;
    if (this.hasFts) {
      try {
        this.stmtSearchFts = this.db.prepare(`
      SELECT ${LAW_SEARCH_COLUMNS_FTS}
      FROM law_fts
      JOIN law l ON l.name = law_fts.name
      JOIN category c ON c.id = l.category_id
      WHERE law_fts MATCH ?
        AND (l.expired = 0 OR l.expired IS NULL)
      ORDER BY l.publish DESC, bm25(law_fts) LIMIT ?
    `);
      } catch {
        this.ftsDegraded = true;
        this.stmtSearchFts = null;
      }
    }
    this.stmtFindByName = this.db.prepare(`
      SELECT ${LAW_SEARCH_COLUMNS}
      FROM law l
      JOIN category c ON c.id = l.category_id
      WHERE l.name LIKE ? ESCAPE '\\'
      ORDER BY l.publish DESC
      LIMIT ?
    `);
    this.stmtGetById = this.db.prepare(`
      SELECT ${LAW_SEARCH_COLUMNS}
      FROM law l
      JOIN category c ON c.id = l.category_id
      WHERE l.id = ?
    `);
    this.stmtGetCategories = this.db.prepare(
      'SELECT id, name, folder, isSubFolder, "group" FROM category ORDER BY "order"',
    );
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM law");
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded;
  }

  /** FTS5 BM25 全文搜索；短查询/无 FTS 时降级 LIKE。 */
  search(keyword: string, options: LegalSearchOptions = {}): LawSearchResult[] {
    const limit = options.limit ?? 10;
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const runes = Array.from(trimmed);
    let rows: LawRow[];
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
        // FTS5 模块缺失或查询异常（如运行时 SQLite 未编译 FTS5，MATCH 抛
        // "no such module: fts5"）：整体降级 LIKE，避免工具执行崩溃。
        this.ftsDegraded = true;
        rows = this.searchLike(trimmed, options, limit);
      }
    }

    return rows.map(row => toSearchResult(row));
  }

  /** 按名称精确/模糊查找法律（返回全部版本记录）。 */
  findByName(name: string, limit = 10): LawRecord[] {
    const rows = this.stmtFindByName.all(`%${name.replace(/[%_\\]/g, m => `\\${m}`)}%`, limit) as LawRow[];
    return rows.map(toRecord);
  }

  /** 按 id（主键）精确查询。 */
  getById(id: string): LawRecord | undefined {
    const row = this.stmtGetById.get(id) as LawRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** 批量按 id 查询（一次 IN 查询，替代循环 getById 的逐次 prepare+执行）。 */
  getByIds(ids: string[]): LawRecord[] {
    const uniqueIds = Array.from(new Set(ids.filter(id => id.length > 0)));
    if (uniqueIds.length === 0) return [];
    if (uniqueIds.length === 1) {
      const record = this.getById(uniqueIds[0]!);
      return record ? [record] : [];
    }
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
      SELECT ${LAW_SEARCH_COLUMNS}
      FROM law l
      JOIN category c ON c.id = l.category_id
      WHERE l.id IN (${placeholders})
    `)
      .all(...uniqueIds) as LawRow[];
    return rows.map(toRecord);
  }

  /** 列出全部分类（category 表）。 */
  getCategories(): LawCategory[] {
    return this.stmtGetCategories.all() as LawCategory[];
  }

  /** 统计总数（诊断用）。 */
  count(): number {
    const row = this.stmtCount.get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }

  private searchFts(keyword: string, options: LegalSearchOptions, limit: number): LawRow[] {
    // trigram 分词对引号敏感：整体作为 phrase 查询。
    // 注意：law_fts 与 law 表的 rowid **不对齐**（不同导入批次），
    // 正确关联键是 name（同名多版本在 JS 层去重，保留 bm25 最高者）。
    return this.searchFtsWithQuery(escapeFtsPhrase(keyword), options, limit);
  }

  /** 多个关键词 OR 组合的 FTS 查询（用于长查询切词降级）。 */
  private searchFtsKeywords(keywords: string[], options: LegalSearchOptions, limit: number): LawRow[] {
    return this.searchFtsWithQuery(joinFtsOrTerms(keywords), options, limit);
  }

  private searchFtsWithQuery(query: string, options: LegalSearchOptions, limit: number): LawRow[] {
    let rows: LawRow[];
    if (!options.level && !options.category) {
      rows = this.stmtSearchFts!.all(query, limit * 3) as LawRow[];
    } else {
      const { sql, params } = buildLawSearchSql("fts", options);
      rows = this.db.prepare(sql).all(query, ...params, limit * 3) as LawRow[];
    }
    // 放大取数（limit * 3）后按 name 去重，保留最新发布版本
    return dedupeByLawName(rows, limit);
  }

  private searchLike(keyword: string, options: LegalSearchOptions, limit: number): LawRow[] {
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    let rows: LawRow[];
    if (!options.level && !options.category) {
      rows = this.stmtSearchLike.all(pattern, pattern, limit) as LawRow[];
    } else {
      const { sql, params } = buildLawSearchSql("like", options);
      rows = this.db.prepare(sql).all(pattern, pattern, ...params, limit) as LawRow[];
    }
    return rows;
  }
}
