import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { KgNode } from "../patent/types.js";
import { FTS_MIN_RUNES } from "./fts.js";

/**
 * 知识图谱只读存储（基于 patent_kg.db 的 nodes/edges 表）。
 *
 * 设计：**按需 SQL 查询 + 轻量节点缓存**，避免将 217MB / 116K 节点
 * 全量加载进内存（Mady 的内存邻接表方案在 Node 侧过重）。edges 表
 * 已建 (source)/(target)/(relation) 索引，FTS5 表 nodes_fts 提供
 * 关键词检索，查询均在毫秒级。
 */

export type KgNeighbor = {
  /** 邻居节点 id */
  targetId: string;
  /** 关系类型（CITES / RELATED_TO / SIMILAR_TO / CONTAINS / DEFINES…） */
  relation: string;
};

export type KgPathEdge = {
  source: string;
  target: string;
  relation: string;
};

/** 分词模式的分隔符（空格 + 中文标点）。 */
const OR_SEPARATOR_RE = /[\s，。？！、；：,.;!?]+/;
/** 候选词数上限（防超长 query 构造超大 FTS SQL / 多次 LIKE 扫描）。 */
const MAX_OR_TERMS = 8;

/** 关键词搜索选项。 */
export type KgSearchOptions = {
  /** 匹配模式：phrase=整体短语（默认，保持既有行为）；or=分词 OR（多词召回）。 */
  mode?: "phrase" | "or";
};

/** 单条 FTS5 命中（nodes_fts 返回原始行）。 */
type FtsHit = {
  id: string;
  name: string | null;
  title: string | null;
};

export class KgStore {
  private readonly db: DatabaseSync;
  private readonly nodeCache = new Map<string, KgNode | undefined>();
  /** 表结构探测结果：trigram FTS 表优先（scripts/migrate-kg-fts-trigram.mjs 生成），否则 unicode61 旧表；无 FTS 时为 null。 */
  private readonly ftsTable: string | null;

  // 热路径 prepared statements（prepare 一次反复复用，避免每次执行重新编译 SQL）
  private readonly stmtGetNode: StatementSync;
  private readonly stmtLikeSearch: StatementSync;
  private readonly stmtFtsSearch: StatementSync | null;
  private readonly stmtNeighbors: StatementSync;
  private readonly stmtNeighborsByRelation: StatementSync;
  private readonly stmtListByType: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    const ftsRow = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes_fts_trigram', 'nodes_fts') ORDER BY CASE name WHEN 'nodes_fts_trigram' THEN 0 ELSE 1 END LIMIT 1",
      )
      .get() as { name: string } | undefined;
    this.ftsTable = ftsRow?.name ?? null;
    this.stmtGetNode = this.db.prepare(
      `SELECT id, node_type, name, title, content, law_refs_count,
              source, full_ref, chapter, article_number, version
       FROM nodes WHERE id = ?`,
    );
    this.stmtLikeSearch = this.db.prepare(
      `SELECT id FROM nodes
       WHERE name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       LIMIT ?`,
    );
    // 知识库可能未建 FTS（或运行时 SQLite 未编译 FTS5/trigram——如桌面端捆绑
    // 旧 Node），prepare MATCH 会抛错：捕获后降级 LIKE（等价 legal-search 的
    // 能力探测语义），避免构造函数崩溃导致整个 KgStore 不可用。
    this.stmtFtsSearch = null;
    if (this.ftsTable !== null) {
      try {
        this.stmtFtsSearch = this.db.prepare(
          `SELECT id, name, title FROM ${this.ftsTable} WHERE ${this.ftsTable} MATCH ? LIMIT ?`,
        );
      } catch {
        this.stmtFtsSearch = null;
      }
    }
    this.stmtNeighbors = this.db.prepare("SELECT target, relation FROM edges WHERE source = ? LIMIT ?");
    this.stmtNeighborsByRelation = this.db.prepare(
      "SELECT target, relation FROM edges WHERE source = ? AND relation = ? LIMIT ?",
    );
    this.stmtListByType = this.db.prepare("SELECT id FROM nodes WHERE node_type = ? LIMIT ?");
  }

  /** 当前生效的 FTS 模式（诊断用）：trigram 表 / unicode61 旧表 / 无 FTS（LIKE 降级）。 */
  ftsMode(): "trigram" | "unicode61" | "none" {
    if (this.stmtFtsSearch === null) return "none";
    return this.ftsTable === "nodes_fts_trigram" ? "trigram" : "unicode61";
  }

  /** 按 id 查询节点（带缓存）。 */
  getNode(id: string): KgNode | undefined {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id);
    const row = this.stmtGetNode.get(id) as
      | {
          id: string;
          node_type: string | null;
          name: string | null;
          title: string | null;
          content: string | null;
          law_refs_count: number | null;
          source: string | null;
          full_ref: string | null;
          chapter: string | null;
          article_number: string | null;
          version: string | null;
        }
      | undefined;
    const node: KgNode | undefined = row
      ? {
          id: row.id,
          nodeType: row.node_type ?? "",
          name: row.name ?? undefined,
          title: row.title ?? undefined,
          content: row.content ?? undefined,
          lawRefsCount: row.law_refs_count ?? undefined,
          source: row.source ?? undefined,
          fullRef: row.full_ref ?? undefined,
          chapter: row.chapter ?? undefined,
          articleNumber: row.article_number ?? undefined,
          version: row.version ?? undefined,
        }
      : undefined;
    this.nodeCache.set(id, node);
    return node;
  }

  /** 按关键词搜索节点（FTS5 MATCH；短查询或缺失 FTS 时降级 LIKE）。 */
  searchByKeyword(keyword: string, limit = 10, options: KgSearchOptions = {}): KgNode[] {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    if (options.mode === "or") return this.searchByKeywordOr(trimmed, limit);

    const runes = Array.from(trimmed);

    let ids: string[];
    if (this.stmtFtsSearch !== null && runes.length >= FTS_MIN_RUNES) {
      const escaped = trimmed.replace(/"/g, '""');
      const rows = this.stmtFtsSearch!.all(`"${escaped}"`, limit) as FtsHit[];
      ids = rows.map(r => r.id);
      // FTS 词级匹配未命中且无分隔符时降级 LIKE 子串：unicode61 下长句/短语常无完整 token，
      // 子串匹配比 token 完全匹配宽松（如 "以说明书为依据" 作为 token 不存在时仍可命中正文）。
      // 带分隔符短语的 LIKE（%创造性 三步法%）召回率趋近于零，跳过以避免无谓全表扫描。
      if (ids.length === 0 && !OR_SEPARATOR_RE.test(trimmed)) {
        ids = this.likeSearch(trimmed, limit).map(row => row.id);
      }
    } else {
      ids = this.likeSearch(trimmed, limit).map(row => row.id);
    }

    return ids.map(id => this.getNode(id)).filter((n): n is KgNode => n !== undefined);
  }

  /** LIKE 子串检索（name/title/content 任一包含即命中）。 */
  private likeSearch(keyword: string, limit: number): Array<{ id: string }> {
    const pattern = this.likePattern(keyword);
    return this.stmtLikeSearch.all(pattern, pattern, pattern, limit) as Array<{ id: string }>;
  }

  /**
   * 多词 LIKE：把多个词条合并为**单次**全表扫描（每词三列 OR），
   * 替代原先每个词条一次全表扫描（最多 8 词 → 最多 8 次 116K 行扫描）。
   * 语义说明：合并查询总 LIMIT 与原实现（每词 LIMIT 后 Set 并集再 slice(0, limit)）
   * 的**最终召回上限一致**（均 ≤ limit），仅候选行序不同（表行序 vs 词序插入序）；
   * 多词场景的主要召回由 FTS 路径承担，LIKE 仅兜底子串命中。
   */
  private likeSearchTerms(terms: string[], limit: number): Array<{ id: string }> {
    const deduped = Array.from(new Set(terms.map(t => t.trim()).filter(Boolean)));
    if (deduped.length === 0) return [];
    if (deduped.length === 1) return this.likeSearch(deduped[0]!, limit);
    const clause = deduped
      .map(() => "(name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const params: Array<string | number> = deduped.flatMap(term => {
      const pattern = this.likePattern(term);
      return [pattern, pattern, pattern];
    });
    params.push(limit);
    return this.db.prepare(`SELECT id FROM nodes WHERE ${clause} LIMIT ?`).all(...params) as Array<{ id: string }>;
  }

  private likePattern(keyword: string): string {
    return `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
  }

  /**
   * OR 分词检索（多词召回）。
   *
   * nodes_fts 为 FTS5 默认 unicode61 tokenizer：连续汉字构成单个 token，
   * 短语 MATCH 需 token 完全相等且相邻（"创造性 三步法" 基本不命中）。
   * 本模式在单一入口内完成拆词与召回（调用方无需再分词）：
   *   - 短词（≤3 字）直接整体：3 字走 FTS，2 字降级 LIKE
   *   - 分隔符拆词：≥3 字词 FTS `"词1" OR "词2"`，2 字词 LIKE；1 字词丢弃
   *     （LIKE %单字% 命中数万节点，纯噪音）
   *   - 无分隔 4+ 字长词：整体 LIKE 精确子串优先（unicode61 下 4+ 字 token 基本不存在），
   *     窗口子词补充召回（4-5 字 2 字窗 LIKE / ≥6 字 3 字窗 FTS）
   *   - 全部未命中时整体 LIKE 一次（覆盖 3 字词 FTS 未命中但正文含子串的场景）
   */
  private searchByKeywordOr(keyword: string, limit: number): KgNode[] {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const chars = Array.from(trimmed);
    const hasSeparators = OR_SEPARATOR_RE.test(trimmed);

    const ids = new Set<string>();
    const ftsTerms: string[] = [];
    const likeTerms: string[] = [];

    /** 词归入 FTS（≥3 字）或 LIKE（2 字）候选；1 字词丢弃。 */
    const collect = (term: string): void => {
      const runes = Array.from(term.trim());
      if (this.stmtFtsSearch !== null && runes.length >= FTS_MIN_RUNES) ftsTerms.push(term.trim());
      else if (runes.length >= 2) likeTerms.push(term.trim());
    };

    if (!hasSeparators && chars.length <= 3) {
      collect(trimmed);
    } else if (hasSeparators) {
      for (const part of trimmed.split(OR_SEPARATOR_RE)) collect(part);
    } else {
      // 无分隔长词：整体 LIKE 优先（精确子串，插入序靠前以保证限流后存活），窗口子词补充
      if (chars.length >= 4) {
        for (const row of this.likeSearch(trimmed, limit)) ids.add(row.id);
      }
      const step = chars.length <= 5 ? 2 : 3;
      for (let i = 0; i + step <= chars.length; i += step) {
        collect(chars.slice(i, i + step).join(""));
      }
    }

    if (ftsTerms.length > 0) {
      const match = ftsTerms
        .slice(0, MAX_OR_TERMS)
        .map(term => `"${term.replace(/"/g, '""')}"`)
        .join(" OR ");
      const rows = this.stmtFtsSearch!.all(match, limit) as FtsHit[];
      for (const row of rows) ids.add(row.id);
    }

    const mergedTerms = likeTerms.slice(0, MAX_OR_TERMS);
    if (mergedTerms.length > 0) {
      for (const row of this.likeSearchTerms(mergedTerms, limit)) ids.add(row.id);
    }

    // 兜底：候选词均未命中时整体 LIKE 一次（带分隔符短语的子串匹配无意义，跳过）
    if (ids.size === 0 && !hasSeparators && chars.length >= 2) {
      for (const row of this.likeSearch(trimmed, limit)) ids.add(row.id);
    }

    const ordered = [...ids].slice(0, limit);
    return ordered.map(id => this.getNode(id)).filter((n): n is KgNode => n !== undefined);
  }

  /** 查询节点的出向邻居（按 relation 过滤可选）。 */
  getNeighbors(nodeId: string, relation?: string, limit = 20): KgNeighbor[] {
    if (relation) {
      const rows = this.stmtNeighborsByRelation.all(nodeId, relation, limit) as Array<{
        target: string;
        relation: string;
      }>;
      return rows.map(r => ({ targetId: r.target, relation: r.relation }));
    }
    const rows = this.stmtNeighbors.all(nodeId, limit) as Array<{ target: string; relation: string }>;
    return rows.map(r => ({ targetId: r.target, relation: r.relation }));
  }

  /** BFS 最短路径（有向图，沿出边遍历）。找不到返回 null。 */
  bfsPath(fromId: string, toId: string, maxDepth = 5): KgPathEdge[] | null {
    if (fromId === toId) return [];
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; path: KgPathEdge[] }> = [{ id: fromId, path: [] }];

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (path.length >= maxDepth) continue;
      const neighbors = this.getNeighbors(id, undefined, 100);
      for (const n of neighbors) {
        if (visited.has(n.targetId)) continue;
        const nextPath = [...path, { source: id, target: n.targetId, relation: n.relation }];
        if (n.targetId === toId) return nextPath;
        visited.add(n.targetId);
        queue.push({ id: n.targetId, path: nextPath });
      }
    }
    return null;
  }

  /** 按类型列出节点（用于图谱浏览/过滤）。 */
  listByType(nodeType: string, limit = 50): KgNode[] {
    const rows = this.stmtListByType.all(nodeType, limit) as Array<{ id: string }>;
    return rows.map(r => this.getNode(r.id)).filter((n): n is KgNode => n !== undefined);
  }

  /** 展开某个节点的邻居（去重后），附带节点详情。 */
  expandNeighbors(nodeId: string, relation?: string, depth = 2, limit = 20): Array<{ node: KgNode; relation: string }> {
    const seen = new Set<string>([nodeId]);
    const result: Array<{ node: KgNode; relation: string }> = [];
    let frontier = [{ id: nodeId, relation: "" }];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: Array<{ id: string; relation: string }> = [];
      for (const { id } of frontier) {
        const neighbors = this.getNeighbors(id, relation, limit);
        for (const n of neighbors) {
          if (seen.has(n.targetId)) continue;
          seen.add(n.targetId);
          const node = this.getNode(n.targetId);
          if (node) {
            result.push({ node, relation: n.relation });
            next.push({ id: n.targetId, relation: n.relation });
          }
        }
      }
      frontier = next;
    }
    return result;
  }

  close(): void {
    this.nodeCache.clear();
    this.db.close();
  }
}
