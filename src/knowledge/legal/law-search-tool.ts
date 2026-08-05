import type { SatiToolDefinition } from "../../tool/protocol/types.js";
import { resolveKnowledgeDbPaths } from "../config.js";
import { LegalSearchEngine, type LegalSearchOptions } from "./legal-search.js";
import type { LawRecord } from "./types.js";

/**
 * law_search — 中国法律法规全文检索。
 *
 * 基于宝宸知识库（Laws-1.0.0）SQLite 数据，FTS5 BM25 排序优先，
 * 短查询/缺失 FTS 时降级 LIKE。支持按法律层级（法律/行政法规/司法解释/
 * 地方性法规/宪法/案例/部门规章）和分类过滤。
 */

export type LawSearchToolInput = {
  /** 搜索关键词或法条内容（如 "专利法"、"第二十二条"、"创造性"） */
  query: string;
  /** 法律层级过滤（法律/行政法规/司法解释/地方性法规/宪法/案例/部门规章） */
  level?: string;
  /** 分类名称过滤（如 "民法商法"、"行政法"） */
  category?: string;
  /** 返回条数上限（默认 5） */
  limit?: number;
};

export type LawSearchToolOutput = {
  total: number;
  results: Array<LawRecord & { snippet?: string }>;
  dbPath?: string;
};

/** 默认数据库路径（供模块级缓存使用）。 */
let cachedEngine: { engine: LegalSearchEngine; dbPath: string } | null = null;

function getEngine(): { engine: LegalSearchEngine; dbPath: string } | null {
  const { lawDb } = resolveKnowledgeDbPaths();
  if (!lawDb) return null;
  if (cachedEngine && cachedEngine.dbPath === lawDb) return cachedEngine;
  cachedEngine?.engine.close();
  const engine = new LegalSearchEngine(lawDb);
  cachedEngine = { engine, dbPath: lawDb };
  return cachedEngine;
}

/** 截断过长的法条正文（避免超大输出撑爆上下文）。 */
function truncateContent(content: string, maxChars = 4000): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（截断，共 ${content.length} 字）`;
}

export function createLawSearchTool(
  getEngineFn: () => { engine: LegalSearchEngine; dbPath: string } | null = getEngine,
): SatiToolDefinition<LawSearchToolInput, LawSearchToolOutput> {
  return {
    name: "law_search",
    title: "Law Search",
    description:
      "搜索中国法律法规全文（宝宸知识库 9000+ 部法律）。支持全文关键词检索、按法律层级（法律/行政法规/司法解释/地方性法规/宪法/案例/部门规章）和分类过滤。用于查询法条原文、法律名称、立法依据。",
    kind: "custom",
    domain: "legal",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或法条内容（如 专利法、第二十二条、创造性）",
        },
        level: {
          type: "string",
          enum: ["法律", "行政法规", "司法解释", "地方性法规", "宪法", "案例", "部门规章"],
          description: "法律层级过滤",
        },
        category: {
          type: "string",
          description: "分类名称过滤（如 民法商法、行政法、刑法）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 20）",
        },
      },
      required: ["query"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const resolved = getEngineFn();
      if (!resolved) {
        return {
          ok: false,
          code: "setup_required",
          reason: "未找到法律数据库（默认路径 ~/.mady/knowledge/，可用 SATI_KNOWLEDGE_DIR 或 SATI_LAW_DB 指定）",
        };
      }
      return { ok: true };
    },
    execute: async (input: LawSearchToolInput) => {
      const resolved = getEngineFn();
      if (!resolved) {
        return {
          content: [
            { type: "text", text: "错误：未找到法律数据库，请配置 SATI_KNOWLEDGE_DIR 或 SATI_LAW_DB 环境变量。" },
          ],
          metadata: { error: "law_db_not_found" },
        };
      }
      const { engine, dbPath } = resolved;

      const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
      const options: LegalSearchOptions = { limit, level: input.level, category: input.category };

      // 优先精确名称匹配（结果中保持该法律在前）
      const byName = input.query.length >= 2 ? engine.findByName(input.query, 3) : [];
      const nameIds = new Set(byName.map(r => r.id));
      const results = engine.search(input.query, { ...options, limit: limit + nameIds.size });

      // 按 name 去重（同名多版本保留第一条），避免重复条目
      const seen = new Set<string>();
      const merged: Array<LawRecord & { snippet?: string }> = [];
      for (const r of [
        ...byName.map(r => ({ ...r, content: r.content ? truncateContent(r.content) : undefined })),
        ...results
          .filter(r => !nameIds.has(r.id))
          .map(r => ({ ...r, content: r.content ? truncateContent(r.content) : undefined })),
      ]) {
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        merged.push(r);
        if (merged.length >= limit) break;
      }

      const output: LawSearchToolOutput = {
        total: merged.length,
        results: merged,
        dbPath,
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: { domain: "legal", dbPath, fts5: engine.ftsAvailable },
      };
    },
  };
}
