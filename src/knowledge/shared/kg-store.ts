import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { KgNode } from "../patent/types.js";
import { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms } from "./fts.js";
import { openKnowledgeDb } from "./db-version.js";
import { KNOWLEDGE_DB } from "./schema-versions.js";
import { toNode, type FtsHit, type NodeRow } from "./kg/row-mapper.js";
import { introspectKgStore, type KgSchema } from "./kg/schema-introspector.js";
import { GraphTraversal, type KgNeighbor, type KgPathEdge } from "./kg/graph-traversal.js";

/**
 * 知识图谱只读存储（双 schema 兼容）。
 *
 * 优先 knowledge.db 统一 schema（kg_nodes/kg_edges/kg_nodes_fts，trigram，
 * XiaoNuo 管道产物）；兼容旧 patent_kg.db（nodes/edges/nodes_fts*）。
 *
 * 设计：**按需 SQL 查询 + 轻量节点缓存**，避免将 217MB / 116K 节点
 * 全量加载进内存（Mady 的内存邻接表方案在 Node 侧过重）。edges 表
 * 已建 (source)/(target)/(relation) 索引，FTS5 表 nodes_fts 提供
 * 关键词检索，查询均在毫秒级。
 */

// 类型再导出（定义见 kg/ 子模块，保持 "./kg-store.js" 导出面不变）
export type { KgSchema };
export type { KgNeighbor, KgPathEdge };

/** 分词模式的分隔符（空格 + 中文标点）。 */
const OR_SEPARATOR_RE = /[\s，。？！、；：,.;!?]+/;
/** 候选词数上限（防超长 query 构造超大 FTS SQL / 多次 LIKE 扫描）。 */
const MAX_OR_TERMS = 8;

/** 关键词搜索选项。 */
export type KgSearchOptions = {
  /** 匹配模式：phrase=整体短语（默认，保持既有行为）；or=分词 OR（多词召回）。 */
  mode?: "phrase" | "or";
};

export class KgStore {
  private readonly db: DatabaseSync;
  private readonly nodeCache = new Map<string, KgNode | undefined>();
  /** 生效的 schema：unified=knowledge.db（kg_nodes），legacy=patent_kg.db（nodes）。 */
  private readonly schema: KgSchema;
  /** 表结构探测结果：trigram FTS 表优先（scripts/migrate-kg-fts-trigram.mjs 生成），否则 unicode61 旧表；无 FTS 时为 null。 */
  private readonly ftsTable: string | null;
  private readonly graphTraversal: GraphTraversal;

  // 热路径 prepared statements（prepare 一次反复复用，避免每次执行重新编译 SQL）
  private readonly stmtGetNode: StatementSync;
  private readonly stmtLikeSearch: StatementSync;
  private readonly stmtFtsSearch: StatementSync | null;

  constructor(dbPath: string) {
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    this.db = opened.db;
    // 探测 + prepared 组装（schema-introspector）：fail-closed（无表抛错）与
    // FTS prepare 降级（旧 Node 无 FTS5/trigram）契约由 introspectKgStore 承担。
    const introspected = introspectKgStore(this.db, dbPath);
    this.schema = introspected.schema;
    this.ftsTable = introspected.ftsTable;
    this.stmtGetNode = introspected.statements.stmtGetNode;
    this.stmtLikeSearch = introspected.statements.stmtLikeSearch;
    this.stmtFtsSearch = introspected.statements.stmtFtsSearch;
    this.graphTraversal = new GraphTraversal(
      {
        stmtNeighbors: introspected.statements.stmtNeighbors,
        stmtNeighborsByRelation: introspected.statements.stmtNeighborsByRelation,
        stmtListByType: introspected.statements.stmtListByType,
      },
      id => this.getNode(id),
    );
  }

  /** 当前生效的 schema（诊断用）。 */
  schemaKind(): KgSchema {
    return this.schema;
  }

  /** 当前生效的 FTS 模式（诊断用）：trigram 表 / unicode61 旧表 / 无 FTS（LIKE 降级）。 */
  ftsMode(): "trigram" | "unicode61" | "none" {
    if (this.stmtFtsSearch === null) return "none";
    // unified schema（kg_nodes_fts）恒为 trigram。
    if (this.schema === "unified") return "trigram";
    return this.ftsTable === "nodes_fts_trigram" ? "trigram" : "unicode61";
  }

  /** 按 id 查询节点（带缓存）。 */
  getNode(id: string): KgNode | undefined {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id);
    const row = this.stmtGetNode.get(id) as NodeRow | undefined;
    const node = row ? toNode(row) : undefined;
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
      const rows = this.stmtFtsSearch!.all(escapeFtsPhrase(trimmed), limit) as FtsHit[];
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
    const nodeTable = this.schema === "unified" ? "kg_nodes" : "nodes";
    return this.db.prepare(`SELECT id FROM ${nodeTable} WHERE ${clause} LIMIT ?`).all(...params) as Array<{
      id: string;
    }>;
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
      const match = joinFtsOrTerms(ftsTerms.slice(0, MAX_OR_TERMS));
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
    return this.graphTraversal.getNeighbors(nodeId, relation, limit);
  }

  /** BFS 最短路径（有向图，沿出边遍历）。找不到返回 null。 */
  bfsPath(fromId: string, toId: string, maxDepth = 5): KgPathEdge[] | null {
    return this.graphTraversal.bfsPath(fromId, toId, maxDepth);
  }

  /** 按类型列出节点（用于图谱浏览/过滤）。 */
  listByType(nodeType: string, limit = 50): KgNode[] {
    return this.graphTraversal.listByType(nodeType, limit);
  }

  /** 展开某个节点的邻居（去重后），附带节点详情。 */
  expandNeighbors(nodeId: string, relation?: string, depth = 2, limit = 20): Array<{ node: KgNode; relation: string }> {
    return this.graphTraversal.expandNeighbors(nodeId, relation, depth, limit);
  }

  close(): void {
    this.nodeCache.clear();
    this.db.close();
  }
}
