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

const FTS_MIN_RUNES = 3; // trigram tokenizer 要求 3+ 字符

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
  searchByKeyword(keyword: string, limit = 10): KgNode[] {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const runes = Array.from(trimmed);

    let ids: string[];
    if (this.hasFts && runes.length >= FTS_MIN_RUNES) {
      const escaped = trimmed.replace(/"/g, '""');
      const rows = this.db
        .prepare(`SELECT id, name, title FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT ?`)
        .all(`"${escaped}"`, limit) as FtsHit[];
      ids = rows.map(r => r.id);
    } else {
      const pattern = `%${trimmed.replace(/[%_\\]/g, m => `\\${m}`)}%`;
      const rows = this.db
        .prepare(
          `SELECT id FROM nodes
           WHERE name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
           LIMIT ?`,
        )
        .all(pattern, pattern, pattern, limit) as Array<{ id: string }>;
      ids = rows.map(r => r.id);
    }

    return ids.map(id => this.getNode(id)).filter((n): n is KgNode => n !== undefined);
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
