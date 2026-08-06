import type { SatiToolDefinition } from "../protocol/types.js";
import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import { KgStore } from "../../knowledge/shared/kg-store.js";
import { PatentKgAdapter, resolveNodeTypes, type RelevantHit } from "../../knowledge/patent/patent-kg-adapter.js";
import type { KgNode } from "../../knowledge/patent/types.js";

/**
 * patent_kg_query — 专利知识图谱主动查询工具。
 *
 * 检索 knowledge.db 的 kg_nodes/kg_edges（XiaoNuo 产物，21.4 万节点；
 * legacy 兼容 patent_kg.db nodes/edges）中的图谱节点（判例/审查规则/
 * 法条/概念），支持三种模式：
 *   1. query 关键词检索（FTS5 + 相似/引用关系扩展，附命中方式标注）
 *   2. id 节点展开（节点详情 + 相似/引用邻居，用于沿引用关系追查判例）
 *   3. node_type 类型浏览（含 Judgment / LawArticle 别名展开）
 *
 * 与 patent_wiki_search（wiki 卡片正文检索）和 law_search（法条原文）互补：
 * 图谱节点与引用关系 → 本工具；wiki 卡片正文 → patent_wiki_search；法条原文 → law_search。
 */

/** 引用类关系（id 模式展开"沿引用关系追查"）。 */
const CITE_RELATIONS = ["CITES", "CITES_LAW", "FREQUENTLY_CITES", "REFERENCES"] as const;

/** 命中方式排序（keyword → similar → cites）。 */
const VIA_ORDER: Record<RelevantHit["via"], number> = { keyword: 0, similar: 1, cites: 2 };

export type PatentKgQueryInput = {
  /** 关键词检索（FTS5 全文索引，短词自动降级 LIKE）；与 id 二选一。 */
  query?: string;
  /** 节点 id（如 "CASE_005"）：返回节点详情 + 相似/引用邻居；与 query 二选一，id 优先。 */
  id?: string;
  /** 按节点类型浏览/过滤（Case / SupremeCourtJudgment / RegionalCourtJudgment / GuidelineRule / Clause / WikiCard / Concept…；支持 Judgment / LawArticle 别名）。 */
  node_type?: string;
  /** 关键词命中后是否做关系扩展（相似/引用），默认 true。 */
  expand?: boolean;
  /** 是否附节点正文片段（默认 false，截断约 600 字）。 */
  include_content?: boolean;
  /** 返回条数上限（默认 5，最大 10）。 */
  limit?: number;
};

export type PatentKgNeighbor = {
  id: string;
  nodeType: string;
  name?: string;
  title?: string;
  relation: string;
};

export type PatentKgHit = {
  id: string;
  nodeType: string;
  name?: string;
  title?: string;
  /** 命中方式：keyword（关键词直接命中）/ similar（相似扩展）/ cites（引用扩展）。 */
  via?: "keyword" | "similar" | "cites";
  relation?: string;
  /** include_content=true 时的正文片段。 */
  content?: string;
  /** id 模式的相似/引用邻居。 */
  neighbors?: PatentKgNeighbor[];
};

export type PatentKgQueryOutput = {
  total: number;
  hits: PatentKgHit[];
  dbPath?: string;
};

/** 图谱访问引用（适配器为唯一入口；id/类型模式均经适配器，不直取底层 store）。 */
export type PatentKgAdapterRef = {
  adapter: PatentKgAdapter;
  dbPath: string;
};

/** 模块级缓存单例（图谱为只读静态数据，避免每次调用重建连接）。 */
let cachedRef: PatentKgAdapterRef | null = null;

export function getAdapter(): PatentKgAdapterRef | null {
  const { patentKgDb } = resolveKnowledgeDbPaths();
  if (!patentKgDb) return null;
  if (cachedRef && cachedRef.dbPath === patentKgDb) return cachedRef;
  if (cachedRef) cachedRef.adapter.close();
  try {
    const store = new KgStore(patentKgDb);
    cachedRef = { adapter: new PatentKgAdapter(store), dbPath: patentKgDb };
    return cachedRef;
  } catch {
    return null;
  }
}

/** 截断过长节点正文（避免超大输出撑爆上下文）。 */
function truncateContent(content: string | undefined, maxChars = 600): string | undefined {
  if (!content || content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（截断，共 ${content.length} 字）`;
}

function toHit(
  node: KgNode,
  via: RelevantHit["via"] | undefined,
  relation: string | undefined,
  includeContent: boolean,
): PatentKgHit {
  return {
    id: node.id,
    nodeType: node.nodeType,
    name: node.name,
    title: node.title,
    via,
    relation,
    content: includeContent ? truncateContent(node.content) : undefined,
  };
}

/** id 模式：节点详情 + 相似/引用邻居。 */
function queryById(ref: PatentKgAdapterRef, id: string, limit: number, includeContent: boolean): PatentKgQueryOutput {
  const { adapter, dbPath } = ref;
  const node = adapter.getNode(id);
  if (!node) {
    return { total: 0, hits: [], dbPath };
  }

  const neighbors: PatentKgNeighbor[] = [];
  const seen = new Set<string>([id]);
  for (const { node: n, relation } of adapter.getSimilarNodes(id, limit)) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    neighbors.push({ id: n.id, nodeType: n.nodeType, name: n.name, title: n.title, relation });
  }
  for (const relation of CITE_RELATIONS) {
    for (const neighbor of adapter.getNeighbors(id, relation, limit)) {
      if (seen.has(neighbor.targetId)) continue;
      const n = adapter.getNode(neighbor.targetId);
      if (!n) continue;
      seen.add(n.id);
      neighbors.push({ id: n.id, nodeType: n.nodeType, name: n.name, title: n.title, relation: neighbor.relation });
    }
  }

  return {
    total: 1,
    hits: [{ ...toHit(node, undefined, undefined, includeContent), neighbors: neighbors.slice(0, limit) }],
    dbPath,
  };
}

/** 关键词模式：FTS5 关键词检索 + 可选关系扩展（对齐 <memory-context> 的 <knowledge-graph> 标注）。 */
function queryByKeyword(
  ref: PatentKgAdapterRef,
  query: string,
  limit: number,
  expand: boolean,
  includeContent: boolean,
): PatentKgQueryOutput {
  const { adapter, dbPath } = ref;

  // FTS5 unicode61 tokenizer 下短语 MATCH 需词级完全匹配（如 "创造性 三步法" 基本不命中），
  // 分词与召回（≥3 字词 FTS OR、2 字词/长词 LIKE、窗口子词兜底）在 KgStore 的 or 模式内完成，
  // 此处单次检索 + 关系扩展，关键词命中优先排序。
  const hits = adapter.searchRelevant(query, {
    keywordLimit: limit,
    expandLimit: Math.min(limit * 3, 30),
    mode: "or",
  });

  // 命中方式排序：keyword → similar → cites（稳定排序，保持各组内首次出现顺序）
  const top = (expand ? hits : hits.filter(hit => hit.via === "keyword"))
    .sort((a, b) => VIA_ORDER[a.via] - VIA_ORDER[b.via])
    .slice(0, limit);
  return {
    total: top.length,
    hits: top.map(hit => toHit(hit.node, hit.via, hit.relation, includeContent)),
    dbPath,
  };
}

/** 类型浏览模式：按 node_type 列出节点（别名展开后合并去重）。 */
function queryByType(
  ref: PatentKgAdapterRef,
  nodeType: string,
  limit: number,
  includeContent: boolean,
): PatentKgQueryOutput {
  const { adapter, dbPath } = ref;
  const types = resolveNodeTypes(nodeType);
  const seen = new Set<string>();
  const nodes: KgNode[] = [];
  for (const type of types) {
    for (const node of adapter.listByType(type, limit * 2)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
      if (nodes.length >= limit) break;
    }
    if (nodes.length >= limit) break;
  }
  return {
    total: nodes.length,
    hits: nodes.map(node => toHit(node, undefined, undefined, includeContent)),
    dbPath,
  };
}

export function createPatentKgQueryTool(
  getAdapterFn: () => PatentKgAdapterRef | null = getAdapter,
): SatiToolDefinition<PatentKgQueryInput, PatentKgQueryOutput> {
  return {
    name: "patent_kg_query",
    title: "Patent Knowledge Graph Query",
    description:
      "查询专利知识图谱节点（判例/审查规则/法条/概念，116K 节点 + 关系边）。三种模式：① query 关键词检索（FTS5，附相似/引用关系标注）；② id 按节点 id 展开详情与相似/引用邻居（沿引用关系追查判例）；③ node_type 按类型浏览（Case/SupremeCourtJudgment/RegionalCourtJudgment/GuidelineRule/Clause/WikiCard/Concept，支持 Judgment/LawArticle 别名）。与 patent_wiki_search（wiki 卡片正文）和 law_search（法条原文）互补。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "关键词检索（如 创造性 三步法、Bolar例外、禁止反悔）；与 id 二选一",
        },
        id: {
          type: "string",
          description: "节点 id（如 CASE_005）；返回节点详情 + 相似/引用邻居；与 query 二选一，id 优先",
        },
        node_type: {
          type: "string",
          description:
            "按节点类型浏览（Case/SupremeCourtJudgment/RegionalCourtJudgment/GuidelineRule/Clause/WikiCard/Concept；Judgment=最高法院+地方法院判决，LawArticle=法条条款）",
        },
        expand: {
          type: "boolean",
          description: "关键词命中后是否做关系扩展（相似/引用），默认 true",
        },
        include_content: {
          type: "boolean",
          description: "是否附节点正文片段（默认 false，截断约 600 字）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 10）",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const resolved = getAdapterFn();
      if (!resolved) {
        return {
          ok: false,
          code: "setup_required",
          reason:
            "未找到专利知识图谱数据库（默认 ~/.mady/knowledge/knowledge.db 的 kg_nodes，可用 SATI_KNOWLEDGE_DIR 或 SATI_PATENT_KG_DB 指定）",
        };
      }
      return { ok: true };
    },
    execute: async (input: PatentKgQueryInput) => {
      const resolved = getAdapterFn();
      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: "错误：未找到专利知识图谱数据库（knowledge.db kg_nodes），请配置 SATI_KNOWLEDGE_DIR 或 SATI_PATENT_KG_DB 环境变量。",
            },
          ],
          metadata: { error: "patent_kg_db_not_found" },
        };
      }
      const { dbPath } = resolved;
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const includeContent = input.include_content === true;

      if (input.id?.trim()) {
        const output = queryById(resolved, input.id.trim(), limit, includeContent);
        return {
          content: [{ type: "json", value: output }],
          data: output,
          metadata: { domain: "patent", dbPath },
        };
      }
      if (input.query?.trim()) {
        const output = queryByKeyword(resolved, input.query.trim(), limit, input.expand !== false, includeContent);
        return {
          content: [{ type: "json", value: output }],
          data: output,
          metadata: { domain: "patent", dbPath },
        };
      }
      if (input.node_type?.trim()) {
        const output = queryByType(resolved, input.node_type.trim(), limit, includeContent);
        return {
          content: [{ type: "json", value: output }],
          data: output,
          metadata: { domain: "patent", dbPath },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "错误：请提供 query（关键词）、id（节点）或 node_type（类型浏览）之一。",
          },
        ],
        metadata: { error: "invalid_input" },
      };
    },
  };
}
