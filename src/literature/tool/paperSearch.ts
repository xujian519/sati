/**
 * `paper_search` 工具：经文献 Connector 注册表检索学术论文。
 *
 * 与 openscience 的 `science_search` 同构：模型从 `paper_list_sources` 发现
 * `db` id，再经 `paper_search` 查询。源错误（限流/不可用）抛结构化
 * `SatiToolRuntimeError` 并提供可行动指导，与"无结果"天然区分。
 */
import type { PermissionResult } from "../../permission/index.js";
import { SatiToolRuntimeError } from "../../tool/protocol/errors.js";
import type { SatiToolDefinition } from "../../tool/protocol/types.js";
import type { ConnectorHit } from "../protocol/types.js";
import type { ConnectorRegistry } from "../runtime/ConnectorRegistry.js";

export type PaperSearchInput = {
  /** 数据库 id（来自 paper_list_sources，如 "arxiv"、"openalex"）。 */
  db: string;
  /** 数据库原生语法的检索词。 */
  query: string;
  /** 最大命中数（1-50，默认 10）。 */
  limit?: number;
};

export type PaperSearchOutput = {
  db: string;
  query: string;
  hits: ConnectorHit[];
};

export type CreatePaperSearchToolOptions = {
  /** 文献 Connector 注册表（必填）。 */
  registry: ConnectorRegistry;
  /** 结果大小上限（默认 200KB）。 */
  maxResultBytes?: number;
};

const DEFAULT_MAX_RESULT_BYTES = 200_000;

export function createPaperSearchTool(
  options: CreatePaperSearchToolOptions,
): SatiToolDefinition<PaperSearchInput, PaperSearchOutput> {
  const registry = options.registry;

  return {
    name: "paper_search",
    aliases: ["PaperSearch"],
    description: [
      "- Searches scholarly literature databases (arXiv, OpenAlex, Semantic Scholar, Crossref) — free, no API key required",
      "- Pass a `db` id (from `paper_list_sources`) and a `query`",
      "- Returns normalized hits: id, title, summary, and URL",
      "- Use for academic papers, preprints, DOI metadata, and research literature",
      "",
      "Usage notes:",
      "  - Call `paper_list_sources` first to discover available `db` ids",
      "  - Fielded queries are supported by arXiv (e.g. `ti:transformer AND cat:cs.LG`) and OpenAlex",
      "  - This tool is read-only and does not modify files",
    ].join("\n"),
    kind: "network",
    domain: "literature",
    inputSchema: {
      type: "object",
      required: ["db", "query"],
      additionalProperties: false,
      properties: {
        db: {
          type: "string",
          description:
            "Database id to search (from paper_list_sources, e.g. 'arxiv', 'openalex', 'semantic-scholar', 'crossref')",
        },
        query: {
          type: "string",
          description:
            "Search query in the database's native syntax. Be specific; arXiv supports fielded syntax like `ti:transformer`.",
        },
        limit: {
          type: "number",
          description: "Max results (1-50, default 10)",
        },
      },
    },
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "paper_search",
        message: "Scholarly literature search requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "paper_search",
        inputSummary: "paper search",
        reason: {
          type: "tool",
          toolName: "paper_search",
          message: "Scholarly literature search requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow search" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input, context) => {
      const connector = registry.get(input.db);
      if (!connector) {
        const available = registry
          .catalog()
          .map(e => e.id)
          .join(", ");
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          `No database "${input.db}". Available: ${available || "(none registered)"}. Use paper_list_sources.`,
          { tool: "paper_search" },
        );
      }

      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
      let hits: ConnectorHit[];
      try {
        hits = await connector.search(input.query, { limit, signal: context.abortSignal });
      } catch (err) {
        // 源错误 ≠ 无结果：抛出带可行动指导的结构化错误，而不是返回空结果
        // 让模型误以为"查无此文"。调用方取消则原样传播。
        if (context.abortSignal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const rateLimited = /\b(429|503|408)\b/.test(message) || /rate.?limit/i.test(message);
        const guidance = rateLimited
          ? `${connector.name} is rate limiting requests. Wait a few seconds, then retry${
              connector.id === "arxiv" ? " (arXiv allows ~1 request every 3s)" : ""
            }.`
          : `${connector.name} returned an error: ${message}`;
        throw new SatiToolRuntimeError("tool_execution_failed", guidance, { tool: "paper_search", db: connector.id });
      }

      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${input.query}" in ${connector.name}.` }],
          data: { db: input.db, query: input.query, hits: [] },
          metadata: { db: input.db, count: 0 },
        };
      }

      const rows = hits.map(h => {
        const lines = [`## ${h.title}`, `**id**: ${h.id}${h.score !== undefined ? ` · score: ${h.score}` : ""}`];
        if (h.url) lines.push(`**url**: ${h.url}`);
        // arXiv 连接器把自闭合 PDF 链接解析进 extra.pdf，直接暴露给模型。
        const pdf = typeof h.extra?.pdf === "string" ? h.extra.pdf : undefined;
        if (pdf) lines.push(`**pdf**: ${pdf}`);
        if (h.summary) lines.push(h.summary);
        return lines.join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: [`**${connector.name}** — ${hits.length} result(s):`, "", rows.join("\n\n---\n\n")].join("\n"),
          },
        ],
        data: { db: input.db, query: input.query, hits },
        metadata: { db: input.db, count: hits.length },
      };
    },
  };
}
