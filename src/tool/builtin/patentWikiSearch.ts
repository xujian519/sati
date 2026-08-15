import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import { WikiCardLoader, type WikiCardMeta } from "../../knowledge/patent/wiki-card-loader.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * patent_wiki_search — 专利 wiki 知识卡片检索（撰写/审查知识接线）。
 *
 * 检索 src/knowledge/patent/wiki/ 下的专利知识卡片（约 1548 张），支持按
 * 撰写相关目录过滤：说明书（专利实务/说明书）、权利要求（专利实务/权利要求）、
 * 撰写（专利实务/撰写）、附图（专利实务/附图）。标题/概念/领域子串匹配，
 * include_body 时附带卡片正文片段。与 <memory-context> 自动注入互补：
 * 撰写说明书/权利要求时主动检索对应目录卡片，落实"撰写必查卡片清单"。
 */

/** 撰写相关知识目录（wiki 根下的相对路径前缀）。 */
export const PATENT_WIKI_DIRS = {
  specification: "专利实务/说明书",
  claims: "专利实务/权利要求",
  drafting: "专利实务/撰写",
  figures: "专利实务/附图",
} as const;

export type PatentWikiDir = keyof typeof PATENT_WIKI_DIRS;

export type PatentWikiSearchInput = {
  /** 检索关键词（卡片标题/概念/领域子串匹配；空串 = 按目录列出） */
  query: string;
  /** 目录过滤（缺省 = 全部目录） */
  dir?: PatentWikiDir;
  /** 返回条数上限（默认 5，最大 10） */
  limit?: number;
  /** 是否附带卡片正文片段（默认 false） */
  include_body?: boolean;
};

export type PatentWikiSearchOutput = {
  total: number;
  results: Array<{
    id: string;
    title: string;
    relativePath: string;
    concept?: string;
    domain?: string;
    body?: string;
  }>;
  wikiDir?: string;
};

/** 模块级缓存单例（wiki 卡片为静态资产，避免每次调用重建索引）。 */
let cachedLoader: { loader: WikiCardLoader; wikiDir: string } | null = null;

function getLoader(): { loader: WikiCardLoader; wikiDir: string } | null {
  const { wikiDir } = resolveKnowledgeDbPaths();
  if (!wikiDir) return null;
  if (cachedLoader && cachedLoader.wikiDir === wikiDir) return cachedLoader;
  cachedLoader = { loader: new WikiCardLoader(wikiDir), wikiDir };
  return cachedLoader;
}

function toResult(
  meta: WikiCardMeta,
  loader: WikiCardLoader,
  includeBody: boolean,
): PatentWikiSearchOutput["results"][number] {
  const result: PatentWikiSearchOutput["results"][number] = {
    id: meta.id,
    title: meta.title,
    relativePath: meta.relativePath,
    concept: meta.concept,
    domain: meta.domain,
  };
  if (includeBody) {
    const body = loader.formatAsContext(meta.id, 600);
    if (body) result.body = body;
  }
  return result;
}

export function createPatentWikiSearchTool(): SatiToolDefinition<PatentWikiSearchInput, PatentWikiSearchOutput> {
  return {
    name: "patent_wiki_search",
    title: "Patent Wiki Search",
    description:
      "检索专利 wiki 知识卡片（说明书/权利要求/撰写/附图四目录），用于撰写说明书、权利要求书时查询充分公开、" +
      "实施例、数值范围、以说明书为依据等撰写标准。支持 dir 目录过滤（specification/claims/drafting/figures）与 " +
      "include_body 正文片段。撰写说明书前先用本工具检索'撰写必查卡片清单'中的卡片。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "检索关键词（卡片标题/概念/领域子串匹配；空串 = 按目录列出全部卡片）",
        },
        dir: {
          type: "string",
          enum: ["specification", "claims", "drafting", "figures"],
          description: "目录过滤：specification=说明书、claims=权利要求、drafting=撰写、figures=附图（缺省全部）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 10）",
        },
        include_body: {
          type: "boolean",
          description: "是否附带卡片正文片段（默认 false）",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      required: ["total", "results"],
      additionalProperties: false,
      properties: {
        total: { type: "integer" },
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "title", "relativePath"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              relativePath: { type: "string" },
              concept: { type: "string" },
              domain: { type: "string" },
              body: { type: "string" },
            },
          },
        },
        wikiDir: { type: "string" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const resolved = getLoader();
      if (!resolved) {
        return {
          ok: false,
          code: "setup_required",
          reason: "未找到 wiki 卡片目录（默认内置 src/knowledge/patent/wiki，可用 SATI_WIKI_DIR 覆盖）",
        };
      }
      return { ok: true };
    },
    execute: async input => {
      const resolved = getLoader();
      if (!resolved) {
        return {
          content: [
            { type: "text", text: "错误：未找到 wiki 卡片目录（内置 src/knowledge/patent/wiki 或 SATI_WIKI_DIR）。" },
          ],
          metadata: { error: "wiki_dir_not_found" },
        };
      }
      const { loader, wikiDir } = resolved;
      const prefix = input.dir ? PATENT_WIKI_DIRS[input.dir] : "";
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const includeBody = input.include_body === true;

      const metas = loader.searchIn(prefix, input.query ?? "", limit);
      const output: PatentWikiSearchOutput = {
        total: metas.length,
        results: metas.map(meta => toResult(meta, loader, includeBody)),
        wikiDir,
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: { domain: "patent", wikiDir },
      };
    },
  };
}
