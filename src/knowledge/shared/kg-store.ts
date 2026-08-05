import { DatabaseSync } from "node:sqlite";
import type { KgNode } from "../patent/types.js";

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

const FTS_MIN_RUNES = 3; // unicode61 tokenizer 下 2 字词几乎无法以独立 token 匹配，短词走 LIKE
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
  /** 表结构探测结果：是否含 FTS5 表。 */
  private readonly hasFts: boolean;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes_fts'")
      .get() as { c: number };
    this.hasFts = row.c > 0;
  }

  /** 按 id 查询节点（带缓存）。 */
  getNode(id: string): KgNode | undefined {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id);
    const row = this.db
      .prepare(
        `SELECT id, node_type, name, title, content, law_refs_count,
                source, full_ref, chapter, article_number, version
         FROM nodes WHERE id = ?`,
      )
      .get(id) as
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
    if (this.hasFts && runes.length >= FTS_MIN_RUNES) {
      const escaped = trimmed.replace(/"/g, '""');
      const rows = this.db
        .prepare(`SELECT id, name, title FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT ?`)
        .all(`"${escaped}"`, limit) as FtsHit[];
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
    const pattern = `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    return this.db
      .prepare(
        `SELECT id FROM nodes
         WHERE name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
         LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit) as Array<{ id: string }>;
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
      if (this.hasFts && runes.length >= FTS_MIN_RUNES) ftsTerms.push(term.trim());
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
      const rows = this.db
        .prepare(`SELECT id, name, title FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT ?`)
        .all(match, limit) as FtsHit[];
      for (const row of rows) ids.add(row.id);
    }

    for (const term of likeTerms.slice(0, MAX_OR_TERMS)) {
      for (const row of this.likeSearch(term, limit)) ids.add(row.id);
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
      const rows = this.db
        .prepare("SELECT target, relation FROM edges WHERE source = ? AND relation = ? LIMIT ?")
        .all(nodeId, relation, limit) as Array<{ target: string; relation: string }>;
      return rows.map(r => ({ targetId: r.target, relation: r.relation }));
    }
    const rows = this.db
      .prepare("SELECT target, relation FROM edges WHERE source = ? LIMIT ?")
      .all(nodeId, limit) as Array<{ target: string; relation: string }>;
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
    const rows = this.db.prepare("SELECT id FROM nodes WHERE node_type = ? LIMIT ?").all(nodeType, limit) as Array<{
      id: string;
    }>;
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
