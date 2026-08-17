/**
 * `patent_search` 内置工具 — 关键词/布尔检索式检索 Google Patents。
 *
 * 数据引擎为 nuo-patent `searchPatents`（XHR JSON 主路径 + HTML 搜索页回退，
 * ego-browser 反爬优先）。补上 nuo-patent 的检索缺口，与 `patent_metadata`
 * （按号点查）形成"检索 → 详情"闭环。只读、domain: patent。
 */

import { searchPatents as searchPatentsImpl, type PatentSearchHit } from "nuo-patent";
import { cachedSearchPatents } from "../../patent/data/nuo/patentCache.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type PatentSearchInput = {
  /** Google Patents 原生检索语法（关键词/布尔式/assignee:/日期范围） */
  query: string;
  /** 最大命中数（1-50，默认 10） */
  limit?: number;
};

export type PatentSearchHitItem = {
  patent: string;
  title: string;
  assignee: string;
  publicationDate: string;
  priorityDate: string;
  abstract: string;
  url: string;
};

export type PatentSearchOutput = {
  query: string;
  total: number;
  hits: PatentSearchHitItem[];
  /** 非致命警告（解析降级/部分字段缺失） */
  warnings: string[];
};

export type CreatePatentSearchToolOptions = {
  /** 检索函数注入（测试用；缺省用 nuo-patent 的 searchPatents） */
  search?: typeof searchPatentsImpl;
};

function toItem(h: PatentSearchHit): PatentSearchHitItem {
  return {
    patent: h.patent,
    title: h.title,
    assignee: h.assignee,
    publicationDate: h.publication_date,
    priorityDate: h.priority_date,
    abstract: h.abstract,
    url: h.url,
  };
}

/**
 * 提取专利号的基号（去 kind code）：`CN115690481A`→`CN115690481`，
 * `US11452699B2`→`US11452699`。无 kind code 的号返回 undefined（不参与分桶）。
 */
export function baseNumber(patent: string): string | undefined {
  const match = /^([A-Z]{2}\d+)[A-Z]\d?$/.exec(patent);
  return match?.[1];
}

/**
 * P2-06：按基号分桶去重（Google Patents 常返回同申请公开 A / 授权 B / 分案 C
 * 多篇高度相似文本）。同基号保留 publicationDate 最新一篇（无日期视为最旧），
 * 结果保持原 hits 顺序；被合并统计写入 warnings。跨号分案不识别（已知边界）。
 */
export function dedupeByFamily(
  hits: readonly PatentSearchHit[],
  baseWarnings: readonly string[],
): { hits: PatentSearchHit[]; warnings: string[] } {
  const bestByBase = new Map<string, PatentSearchHit>();
  const kept = new Set<string>();
  const dropped = new Map<string, number>();

  for (const hit of hits) {
    const base = baseNumber(hit.patent);
    if (base === undefined) continue;
    const current = bestByBase.get(base);
    if (current === undefined) {
      bestByBase.set(base, hit);
      kept.add(hit.patent);
      continue;
    }
    // publication_date 为 YYYY-MM-DD，字典序即时间序；无日期视为最旧。
    if ((hit.publication_date ?? "") > (current.publication_date ?? "")) {
      bestByBase.set(base, hit);
      kept.delete(current.patent);
      kept.add(hit.patent);
    }
    dropped.set(base, (dropped.get(base) ?? 0) + 1);
  }

  // 保留：各基号桶的最优篇 + 未参与分桶（无 kind code）的号。
  const deduped = hits.filter(h => kept.has(h.patent) || baseNumber(h.patent) === undefined);
  const warnings = [...baseWarnings];
  for (const [base, count] of dropped) {
    const best = bestByBase.get(base);
    const date = best?.publication_date ? ` ${best.publication_date}` : "";
    warnings.push(`family 去重：${base}* 的 ${count + 1} 篇公开/授权变体合并为 1 篇（保留 ${best?.patent}${date}）`);
  }
  return { hits: deduped, warnings };
}

export function createPatentSearchTool(
  options?: CreatePatentSearchToolOptions,
): SatiToolDefinition<PatentSearchInput, PatentSearchOutput> {
  // 默认实现包一层 LRU 缓存 + 并发合并：同一检索式在 TTL 内重复调用（agent
  // 重试/多工具并行）直接命中，不再 spawn ego-browser / 打 Google。
  // 测试注入的 mock search 原样使用（不套缓存，保持行为可预期）。
  const search = options?.search ? options.search : cachedSearchPatents(searchPatentsImpl);

  return {
    name: "patent_search",
    aliases: ["PatentSearch", "search_patents"],
    title: "Patent Search",
    description: [
      "- Searches Google Patents by keyword or boolean query (e.g. '(phase change OR PCM) AND thermal', 'assignee:(Samsung) after:20200101')",
      "- Returns structured hits: patent number, title, assignee, publication date, abstract, URL",
      "- Use for prior-art search, novelty pre-screening, competitor/assignee analysis",
      "",
      "Usage notes:",
      "  - Read-only; query syntax follows Google Patents search grammar",
      "  - Follow up with patent_metadata to fetch full details of a specific hit",
      "  - A network failure is reported as an error; a genuine zero-result search returns empty hits with warnings",
    ].join("\n"),
    kind: "network",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Search query in Google Patents syntax: keywords, phrases, boolean (AND/OR/NOT), fielded (assignee:/inventor:), date ranges (after:/before:).",
        },
        limit: {
          type: "number",
          description: "Max hits (1-50, default 10)",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["query", "total", "hits", "warnings"],
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        total: { type: "integer" },
        hits: {
          type: "array",
          items: {
            type: "object",
            required: ["patent", "title", "assignee", "publicationDate", "priorityDate", "abstract", "url"],
            additionalProperties: false,
            properties: {
              patent: { type: "string" },
              title: { type: "string" },
              assignee: { type: "string" },
              publicationDate: { type: "string" },
              priorityDate: { type: "string" },
              abstract: { type: "string" },
              url: { type: "string" },
            },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input, context) => {
      const query = input.query.trim();
      if (query.length === 0) {
        throw new SatiToolRuntimeError("invalid_tool_input", "Search query is empty.", {
          tool: "patent_search",
        });
      }

      const result = await search(query, {
        limit: input.limit ?? 10,
        signal: context.abortSignal,
      });

      // 区分"源错误"与"无结果"：失败类警告抛结构化错误，解析类警告透出。
      const failure = result.warnings.find(w => /^(查询条件为空|检索超时|检索失败)/.test(w));
      if (failure) {
        if (failure.startsWith("检索超时")) {
          throw new SatiToolRuntimeError("tool_timeout", failure, { tool: "patent_search", query });
        }
        if (failure === "查询条件为空") {
          throw new SatiToolRuntimeError("invalid_tool_input", failure, { tool: "patent_search" });
        }
        throw new SatiToolRuntimeError("tool_execution_failed", failure, { tool: "patent_search", query });
      }

      // P2-06：family 去重——同基号（公开/授权变体）只留 publicationDate 最新一篇。
      const { hits: dedupedHits, warnings } = dedupeByFamily(result.hits, result.warnings);
      const hits = dedupedHits.map(toItem);
      const lines = hits.map(h =>
        [
          `## ${h.title || h.patent}`,
          `**patent**: ${h.patent}${h.publicationDate ? ` · published ${h.publicationDate}` : ""}`,
          `**assignee**: ${h.assignee || "N/A"}`,
          `**url**: ${h.url}`,
          ...(h.abstract ? [h.abstract] : []),
        ].join("\n"),
      );

      return {
        content: [
          {
            type: "text",
            text: [`**patent_search** — ${hits.length} result(s) for "${query}"`, "", lines.join("\n\n---\n\n")].join(
              "\n",
            ),
          },
        ],
        data: { query, total: result.total, hits, warnings },
        metadata: { query, count: hits.length },
      };
    },
  };
}
