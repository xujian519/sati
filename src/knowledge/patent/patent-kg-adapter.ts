import { KgStore } from "../shared/kg-store.js";
import type { KgNode } from "./types.js";

/**
 * 专利知识图谱适配器（封装 KgStore，提供专利语义查询）。
 *
 * searchRelevant：关键词搜索命中节点后，按关系类型做有限扩展
 * （相似节点/引用链），返回带关系的上下文节点。
 */

export type RelevantHit = {
  node: KgNode;
  /** 命中方式：keyword（关键词直接命中）/ similar（SIMILAR_TO 扩展）/ cites（引用扩展） */
  via: "keyword" | "similar" | "cites";
  relation?: string;
};

export type PatentKgSearchOptions = {
  /** 关键词搜索返回数（默认 5）。 */
  keywordLimit?: number;
  /** 每个命中节点扩展的邻居上限（默认 6）。 */
  expandLimit?: number;
};

const SIMILAR_RELATIONS = new Set(["SIMILAR_TO", "RELATED_TO"]);
const CITE_RELATIONS = new Set(["CITES", "CITES_LAW", "FREQUENTLY_CITES", "REFERENCES"]);

export class PatentKgAdapter {
  constructor(private readonly store: KgStore) {}

  /** 按 id 取节点（语义召回命中后回查详情）。 */
  getNode(id: string): KgNode | undefined {
    return this.store.getNode(id);
  }

  /** 关键词搜索 + 关系扩展。 */
  searchRelevant(query: string, options: PatentKgSearchOptions = {}): RelevantHit[] {
    const keywordLimit = options.keywordLimit ?? 5;
    const expandLimit = options.expandLimit ?? 6;
    const hits = this.store.searchByKeyword(query, keywordLimit);
    const results: RelevantHit[] = [];
    const seen = new Set<string>();

    for (const node of hits) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      results.push({ node, via: "keyword" });
    }

    // 扩展：相似节点 + 引用关系（取优先类型，避免重复）
    for (const hit of hits) {
      for (const relation of SIMILAR_RELATIONS) {
        for (const neighbor of this.store.getNeighbors(hit.id, relation, expandLimit)) {
          if (seen.has(neighbor.targetId)) continue;
          const node = this.store.getNode(neighbor.targetId);
          if (!node) continue;
          seen.add(node.id);
          results.push({ node, via: "similar", relation });
        }
      }
      for (const relation of CITE_RELATIONS) {
        for (const neighbor of this.store.getNeighbors(hit.id, relation, 4)) {
          if (seen.has(neighbor.targetId)) continue;
          const node = this.store.getNode(neighbor.targetId);
          if (!node) continue;
          seen.add(node.id);
          results.push({ node, via: "cites", relation });
        }
      }
    }

    return results;
  }

  /** 两个节点间的引用链路径（BFS，最长 5 跳）。 */
  getCitationChain(fromId: string, toId: string): Array<{ source: string; target: string; relation: string }> | null {
    return this.store.bfsPath(fromId, toId, 5);
  }

  /** 展开某节点的相似/相关邻居。 */
  getSimilarNodes(nodeId: string, limit = 10): Array<{ node: KgNode; relation: string }> {
    const results: Array<{ node: KgNode; relation: string }> = [];
    const seen = new Set<string>([nodeId]);
    for (const relation of SIMILAR_RELATIONS) {
      for (const neighbor of this.store.getNeighbors(nodeId, relation, limit)) {
        if (seen.has(neighbor.targetId)) continue;
        const node = this.store.getNode(neighbor.targetId);
        if (!node) continue;
        seen.add(node.id);
        results.push({ node, relation });
      }
    }
    return results;
  }

  /** 按类型列出节点（如 "IPC"、"GuidelineRule"、"WikiCard"）。 */
  listByType(nodeType: string, limit = 50): KgNode[] {
    return this.store.listByType(nodeType, limit);
  }
}
