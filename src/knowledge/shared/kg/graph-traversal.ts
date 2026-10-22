/**
 * src/knowledge/shared/kg — 图谱遍历（图算法独立模块）。
 *
 * 从 kg-store.ts 拆出（A4 轮次 3）：getNeighbors / bfsPath / listByType /
 * expandNeighbors 四个图操作独立成类，经构造注入 prepared statements 与
 * getNode 回读钩子（无 DB 生命周期责任，可独立单测）。
 */

import type { StatementSync } from "node:sqlite";
import type { KgNode } from "../../patent/types.js";

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

export class GraphTraversal {
  /**
   * BFS 队列硬上限（P0-2 防护）：21 万节点图中，高度数节点（如"创造性"概念）
   * 单层可扩展至数百邻居，5 层 BFS 队列理论上限 100^5。设置 10000 上限后
   * 超出即返回 null（调用方按"不可达"处理），避免 OOM。
   */
  private static readonly BFS_MAX_QUEUE_SIZE = 10_000;

  constructor(
    private readonly stmts: {
      stmtNeighbors: StatementSync;
      stmtNeighborsByRelation: StatementSync;
      stmtListByType: StatementSync;
    },
    private readonly getNode: (id: string) => KgNode | undefined,
  ) {}

  /** 查询节点的出向邻居（按 relation 过滤可选）。 */
  getNeighbors(nodeId: string, relation?: string, limit = 20): KgNeighbor[] {
    const rows = relation
      ? (this.stmts.stmtNeighborsByRelation.all(nodeId, relation, limit) as Array<{
          target: string;
          relation: string;
        }>)
      : (this.stmts.stmtNeighbors.all(nodeId, limit) as Array<{ target: string; relation: string }>);
    return rows.map(r => ({ targetId: r.target, relation: r.relation }));
  }

  /**
   * BFS 最短路径（有向图，沿出边遍历）。找不到返回 null。
   *
   * 防护：队列规模超过 BFS_MAX_QUEUE_SIZE 时提前返回 null（高度数节点
   * 扇出爆炸场景），避免 OOM。调用方（PatentKgAdapter.getCitationChain）
   * 按"不可达"处理。
   */
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
        // 队列规模防护：高度数节点扇出爆炸时提前终止，避免 OOM。
        if (queue.length > GraphTraversal.BFS_MAX_QUEUE_SIZE) return null;
      }
    }
    return null;
  }

  /** 按类型列出节点（用于图谱浏览/过滤）。 */
  listByType(nodeType: string, limit = 50): KgNode[] {
    const rows = this.stmts.stmtListByType.all(nodeType, limit) as Array<{ id: string }>;
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
}
