import { TtlCache } from "../../shared/ttl-cache.js";
import { KgStore, type KgNeighbor, type KgSchema } from "../shared/kg-store.js";
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
  /** 关键词匹配模式：phrase（默认）/ or（分词 OR，多词召回）。 */
  mode?: "phrase" | "or";
};

const SIMILAR_RELATIONS = new Set(["SIMILAR_TO", "RELATED_TO"]);
const CITE_RELATIONS = new Set(["CITES", "CITES_LAW", "FREQUENTLY_CITES", "REFERENCES"]);

/**
 * node_type 别名映射：数据库实际类型与 types.ts 中 KgNodeType 定义不一致
 * （如 KgNodeType 的 "Judgment" 对应 db 中的 SupremeCourtJudgment / RegionalCourtJudgment）。
 *
 * P1-2 外部配置化：默认内置映射覆盖 XiaoNuo 管道产物；构造时可传入额外别名，
 * 与内置合并（外部优先）。新增节点类型（如 InvalidationDecision）无需改代码，
 * 只需在装配层传入扩展映射即可。
 */
const DEFAULT_NODE_TYPE_ALIASES: Record<string, string[]> = {
  Judgment: ["SupremeCourtJudgment", "RegionalCourtJudgment"],
  LawArticle: ["Clause", "Chapter"],
  Concept: ["Concept", "ConceptDetail", "一级概念", "二级概念", "三级概念"],
};

/** 合并内置与外部别名（外部优先，大小写不敏感匹配）。 */
function mergeAliases(external?: Record<string, string[]>): Record<string, string[]> {
  if (!external) return DEFAULT_NODE_TYPE_ALIASES;
  return { ...DEFAULT_NODE_TYPE_ALIASES, ...external };
}

/** 解析 node_type（别名展开；未命中别名时按数据库实际类型透传）。 */
export function resolveNodeTypes(raw: string, aliases?: Record<string, string[]>): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const effective = aliases ?? DEFAULT_NODE_TYPE_ALIASES;
  const exact = effective[trimmed];
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  for (const [alias, types] of Object.entries(effective)) {
    if (alias.toLowerCase() === lower) return types;
  }
  return [trimmed];
}

/** PatentKgAdapter 构造选项。 */
export type PatentKgAdapterOptions = {
  /**
   * 额外的 node_type 别名映射（与内置合并，外部优先）。
   * 新增节点类型（如 InvalidationDecision）无需改代码，装配层传入即可。
   */
  nodeTypeAliases?: Record<string, string[]>;
  /**
   * searchRelevant 查询结果缓存 TTL（ms，默认 30_000）。
   * 设为 0 关闭缓存。patent_kg_query 工具直接调用 adapter 不经过 provider 缓存，
   * 此层缓存避免高频工具调用重复查同一关键词。
   */
  searchCacheTtlMs?: number;
  /** searchRelevant 查询结果缓存上限（默认 64）。 */
  searchCacheMaxSize?: number;
};

export class PatentKgAdapter {
  private readonly aliases: Record<string, string[]>;
  /** P1-1：searchRelevant 查询结果缓存（TTL 30s，LRU 上限 64）。 */
  private readonly searchCache?: TtlCache<string, RelevantHit[]>;

  constructor(
    private readonly store: KgStore,
    options: PatentKgAdapterOptions = {},
  ) {
    this.aliases = mergeAliases(options.nodeTypeAliases);
    const ttlMs = options.searchCacheTtlMs ?? 30_000;
    this.searchCache =
      ttlMs > 0 ? new TtlCache<string, RelevantHit[]>({ ttlMs, maxSize: options.searchCacheMaxSize ?? 64 }) : undefined;
  }

  /** 按 id 取节点（语义召回命中后回查详情）。 */
  getNode(id: string): KgNode | undefined {
    return this.store.getNode(id);
  }

  /** 关键词搜索 + 关系扩展（P1-1：同 query+options 30s 内复用缓存结果）。 */
  searchRelevant(query: string, options: PatentKgSearchOptions = {}): RelevantHit[] {
    const keywordLimit = options.keywordLimit ?? 5;
    const expandLimit = options.expandLimit ?? 6;
    const mode = options.mode ?? "phrase";
    const cacheKey = `${query}|${keywordLimit}|${expandLimit}|${mode}`;
    const cached = this.searchCache?.get(cacheKey);
    if (cached) return cached;

    const hits = this.store.searchByKeyword(query, keywordLimit, { mode });
    const results = this.expandRelations(hits, expandLimit);
    this.searchCache?.set(cacheKey, results);
    return results;
  }

  /** 关键词命中后按相似/引用关系扩展（抽出以便缓存路径复用）。 */
  private expandRelations(hits: KgNode[], expandLimit: number): RelevantHit[] {
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

  /** 查询节点的出向邻居（relation 过滤可选）。 */
  getNeighbors(nodeId: string, relation?: string, limit = 20): KgNeighbor[] {
    return this.store.getNeighbors(nodeId, relation, limit);
  }

  /** KG FTS tokenizer 实际生效模式（诊断用：trigram/unicode61/none）。 */
  ftsMode(): "trigram" | "unicode61" | "none" {
    return this.store.ftsMode();
  }

  /** KG FTS 探测明细（诊断用：schema + 库中是否有 FTS 表），与 ftsMode 同源。 */
  ftsProbe(): { schema: KgSchema; tablePresent: boolean } {
    return this.store.ftsProbe();
  }

  close(): void {
    this.store.close();
  }
}
