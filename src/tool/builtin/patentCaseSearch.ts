import type { SatiToolDefinition } from "../protocol/types.js";
import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import { CaseLawSearchEngine } from "../../knowledge/case-law/case-law-search.js";
import type { CaseLawDocType, CaseLawHit, CaseLawSearchOptions } from "../../knowledge/case-law/types.js";

/**
 * patent_case_search — 专利判例全文检索。
 *
 * 基于外接 knowledge.db（documents/chunks/docs_fts 表）的判例全文，
 * FTS5（trigram, BM25）优先、短查询/无 FTS 时降级 LIKE。支持按文档类型
 * （case=无效复审决定 / judgment=专利判决）与法院过滤。
 * 用于无效宣告分析、OA 答复检索"相似在先决定的理由论证与证据认定"。
 */

export type PatentCaseSearchInput = {
  /** 检索关键词（如 "创造性 三步法"、"技术启示"、"区别特征 预料不到的效果"） */
  query: string;
  /** 文档类型过滤：case=无效复审决定，judgment=专利判决（缺省全部） */
  doc_type?: CaseLawDocType;
  /** 审理法院过滤（子串匹配，如 "最高人民法院"；judgment 生效） */
  court?: string;
  /** 返回条数上限（默认 5，最大 10） */
  limit?: number;
  /** 是否附命中片段（默认 true，截断约 800 字） */
  include_content?: boolean;
};

export type PatentCaseSearchOutput = {
  total: number;
  results: Array<{
    documentId: string;
    docType: string;
    title: string;
    decisionNumber?: string;
    caseNumber?: string;
    court?: string;
    source?: string;
    charCount: number;
    snippet?: string;
    ftsRank?: number | null;
    via: "fts" | "like";
  }>;
  dbPath?: string;
};

/** 引擎访问引用（便于测试注入 mock）。 */
export type CaseLawEngineRef = { engine: CaseLawSearchEngine; dbPath: string };

/** 模块级缓存单例（判例库为只读静态数据，避免每次调用重建连接）。 */
let cachedRef: CaseLawEngineRef | null = null;

export function getCaseLawEngine(): CaseLawEngineRef | null {
  const { caseDb } = resolveKnowledgeDbPaths();
  if (!caseDb) return null;
  if (cachedRef && cachedRef.dbPath === caseDb) return cachedRef;
  if (cachedRef) cachedRef.engine.close();
  try {
    const engine = new CaseLawSearchEngine(caseDb);
    cachedRef = { engine, dbPath: caseDb };
    return cachedRef;
  } catch {
    return null;
  }
}

/** 截断过长的命中片段（避免超大输出撑爆上下文）。 */
function truncateSnippet(content: string, maxChars = 800): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（截断，共 ${content.length} 字）`;
}

function toResult(hit: CaseLawHit, includeContent: boolean): PatentCaseSearchOutput["results"][number] {
  return {
    documentId: hit.documentId,
    docType: hit.docType,
    title: hit.title,
    decisionNumber: hit.decisionNumber,
    caseNumber: hit.caseNumber,
    court: hit.court,
    source: hit.source,
    charCount: hit.charCount,
    snippet: includeContent ? truncateSnippet(hit.snippet) : undefined,
    ftsRank: hit.ftsRank,
    via: hit.via,
  };
}

export function createPatentCaseSearchTool(
  getRefFn: () => CaseLawEngineRef | null = getCaseLawEngine,
): SatiToolDefinition<PatentCaseSearchInput, PatentCaseSearchOutput> {
  return {
    name: "patent_case_search",
    title: "Patent Case Law Search",
    description:
      "检索本地专利判例全文（无效复审决定/专利判决，knowledge.db，FTS5 BM25 优先）。用于无效宣告分析、OA 答复时检索相似在先决定的理由论证与证据认定：如查'创造性 三步法 技术启示'的无效决定全文实例。支持 doc_type（case=无效决定/judgment=判决）与 court（法院）过滤。默认排除 wiki 审查标准卡片（审查标准请用 patent_wiki_search）。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "检索关键词（如 创造性 三步法、技术启示、区别特征 预料不到的效果）",
        },
        doc_type: {
          type: "string",
          enum: ["case", "judgment"],
          description: "文档类型过滤：case=无效复审决定，judgment=专利判决（缺省全部）",
        },
        court: {
          type: "string",
          description: "审理法院过滤（子串匹配，如 最高人民法院）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 10）",
        },
        include_content: {
          type: "boolean",
          description: "是否附命中片段（默认 true，截断约 800 字）",
        },
      },
      required: ["query"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const resolved = getRefFn();
      if (!resolved) {
        return {
          ok: false,
          code: "setup_required",
          reason: "未找到判例全文数据库（默认路径 ~/.mady/knowledge/knowledge.db，可用 SATI_CASE_DB 指定路径）",
        };
      }
      return { ok: true };
    },
    execute: async (input: PatentCaseSearchInput) => {
      const resolved = getRefFn();
      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: "错误：未找到判例全文数据库（knowledge.db），请配置 SATI_CASE_DB 环境变量指向数据库路径，或放入默认目录 ~/.mady/knowledge/。",
            },
          ],
          metadata: { error: "case_db_not_found" },
        };
      }
      const { engine, dbPath } = resolved;

      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const options: CaseLawSearchOptions = {
        limit,
        docType: input.doc_type,
        court: input.court,
        // 判例检索默认排除 wiki 审查标准卡片（source=wiki，如"创造性-审查标准-*"），
        // 仅返回 raw 判例全文；审查标准请走 patent_wiki_search。
        excludeSource: "wiki",
      };
      const includeContent = input.include_content ?? true;

      const hits = engine.search(input.query, options);
      const output: PatentCaseSearchOutput = {
        total: hits.length,
        results: hits.map(hit => toResult(hit, includeContent)),
        dbPath,
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: { domain: "patent", dbPath, fts5: engine.ftsAvailable },
      };
    },
  };
}
