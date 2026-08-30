import type { SatiToolDefinition } from "../../tool/protocol/types.js";
import { resolveKnowledgeDbPaths } from "../config.js";
import { LegalSearchEngine, type LegalSearchOptions } from "./legal-search.js";
import { KnowledgeLawSearch } from "./knowledge-law-search.js";
import { computeEffectiveStatus, loadLawVersionMeta, type LawVersionMeta } from "./version-meta.js";
import type { LawRecord, LawStatus, LegalSearchSource } from "./types.js";

/**
 * law_search — 中国法律法规全文检索。
 *
 * 法规后端优先 knowledge.db（doc_type='law_article'，XiaoNuo 产物，
 * docs_fts trigram + BM25）；无 knowledge.db 时回退宝宸知识库
 * （laws-full.db，Laws-1.0.0）。FTS5 优先，短查询/缺失 FTS 时降级 LIKE。
 * 支持按法律层级和分类过滤。
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
let cachedEngine: { engine: LegalSearchSource; dbPath: string } | null = null;

function getEngine(): { engine: LegalSearchSource; dbPath: string } | null {
  const { lawDb, knowledgeDb } = resolveKnowledgeDbPaths();
  // knowledge.db 存在且有 law_article 文档时优先（复用 XiaoNuo 产物）。
  if (knowledgeDb) {
    try {
      const engine = new KnowledgeLawSearch(knowledgeDb);
      if (engine.count() > 0) {
        if (cachedEngine && cachedEngine.dbPath !== knowledgeDb) cachedEngine.engine.close();
        cachedEngine = { engine, dbPath: knowledgeDb };
        return cachedEngine;
      }
      engine.close();
    } catch {
      // 法规后端打开失败，回退 legacy laws-full。
    }
  }
  if (!lawDb) return null;
  if (cachedEngine && cachedEngine.dbPath === lawDb) return cachedEngine;
  cachedEngine?.engine.close();
  try {
    const engine = new LegalSearchEngine(lawDb);
    cachedEngine = { engine, dbPath: lawDb };
    return cachedEngine;
  } catch {
    // legacy 库损坏/版本不符：与上方 knowledge.db 分支对称，回退 null（setup_required 提示）。
    return null;
  }
}

/** 截断过长的法条正文（避免超大输出撑爆上下文）。 */
function truncateContent(content: string, maxChars = 4000): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（截断，共 ${content.length} 字）`;
}

/** 离线版本沿革 meta 缓存（构造期加载一次，不在请求路径读盘；缺失/损坏降级空 map）。 */
let versionMetaCache: Map<string, LawVersionMeta> | null = null;

function getVersionMeta(): Map<string, LawVersionMeta> {
  if (versionMetaCache === null) versionMetaCache = loadLawVersionMeta();
  return versionMetaCache;
}

/**
 * 版本状态标注：按位置（computeEffectiveStatus）+ 失效标志 + 离线 meta 权威覆盖。
 *
 * 优先级：meta 文件判定（离线治理，权威） > expired 失效标志（laws-full 硬数据）
 * > 版本位置（查询结果动态判定，仅同名多版本时有值）。单版本非过期且无 meta
 * 时返回 undefined（不标，避免噪音）。
 */
function resolveVersionStatus(
  position: LawStatus | undefined,
  expired: number,
  metaStatus: LawStatus | undefined,
): LawStatus | undefined {
  if (metaStatus === "已废止" || metaStatus === "待核验") return metaStatus;
  if (expired === 1) return "已废止";
  return position;
}

export function createLawSearchTool(
  getEngineFn: () => { engine: LegalSearchSource; dbPath: string } | null = getEngine,
  getVersionMetaFn: () => Map<string, LawVersionMeta> = getVersionMeta,
): SatiToolDefinition<LawSearchToolInput, LawSearchToolOutput> {
  return {
    name: "law_search",
    outputSchema: {
      type: "object",
      properties: {},
    },
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
          reason: "未找到法律数据库（默认路径 ~/.sati/knowledge/，可用 SATI_KNOWLEDGE_DIR 或 SATI_LAW_DB 指定）",
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

      // 优先精确名称匹配（结果中保持该法律在前）。
      // 搜索结果按不同法律名配额取数（limit 即配额；多取的行经 seen 去重丢弃）。
      const byName = input.query.length >= 2 ? engine.findByName(input.query, 3) : [];
      const results = engine.search(input.query, options);

      // 精确名命中按 name 分组：同名多版本（如 laws-full 多版本库）标注
      // status/supersededBy（A2 版本沿革——输出"当前版本/历史版本"）；单版本不标避免噪音。
      const byNameGroups = new Map<string, Array<LawRecord & { snippet?: string }>>();
      for (const r of byName) {
        const key = r.name;
        if (!byNameGroups.has(key)) byNameGroups.set(key, []);
        byNameGroups.get(key)!.push({ ...r, content: r.content ? truncateContent(r.content) : undefined });
      }

      const versionMeta = getVersionMetaFn();
      const merged: Array<LawRecord & { snippet?: string }> = [];
      const seen = new Set<string>();
      // 「不同法律名」配额：同名多版本不挤占不同法律（同名全部版本都展示，
      // 保留版本沿革价值，但每个 name 只占 1 席配额——不同法律数 ≤ limit）。
      let nameCount = 0;
      for (const [name, versions] of byNameGroups) {
        if (seen.has(name) || nameCount >= limit) continue;
        seen.add(name);
        nameCount += 1;
        versions.sort((a, b) => (b.publish ?? "").localeCompare(a.publish ?? ""));
        const metaStatus = versionMeta.get(name)?.status;
        const dates = versions.map(v => v.publish ?? "");
        const latestLabel = versions[0]!.publish ? `${name}（${versions[0]!.publish} 版）` : name;
        versions.forEach(r => {
          // 位置状态经 computeEffectiveStatus 判定（生产接线，收口内联重复）；
          // 单版本时 position 为 undefined（不标，避免噪音）。
          const position = versions.length > 1 ? computeEffectiveStatus(dates, r.publish ?? "") : undefined;
          const status = resolveVersionStatus(position, r.expired, metaStatus);
          const base = status === undefined ? r : { ...r, status };
          merged.push(status === "已被修订" ? { ...base, supersededBy: latestLabel } : base);
        });
      }

      // 全文检索命中：按 name 去重保留最新版（现状），跳过已由精确名引入的；
      // 命中过期/已废止法律时补失效标注（不硬过滤，标给模型判断）。
      for (const r of results) {
        if (nameCount >= limit) break;
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        nameCount += 1;
        const metaStatus = versionMeta.get(r.name)?.status;
        const status = resolveVersionStatus(undefined, r.expired, metaStatus);
        const base = status === undefined ? r : { ...r, status };
        merged.push({ ...base, content: r.content ? truncateContent(r.content) : undefined });
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
