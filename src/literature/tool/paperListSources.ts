/**
 * `paper_list_sources` 工具：列出文献 Connector 注册表中的可用数据源。
 *
 * 与 openscience 的 `science_list_dbs` 同构：模型先发现 `db` id，再经
 * `paper_search` 查询。无论接入多少个数据源，agent 可见的工具数恒定。
 */
import type { PermissionResult } from "../../permission/index.js";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../tool/protocol/types.js";
import type { CatalogEntry } from "../protocol/types.js";
import type { ConnectorRegistry } from "../runtime/ConnectorRegistry.js";

export type PaperListSourcesInput = {
  /** 可选域过滤（当前仅 "literature"）。 */
  domain?: string;
};

export type PaperListSourcesOutput = {
  sources: CatalogEntry[];
  domains: string[];
};

export type CreatePaperListSourcesToolOptions = {
  /** 文献 Connector 注册表（必填）。 */
  registry: ConnectorRegistry;
};

export function createPaperListSourcesTool(
  options: CreatePaperListSourcesToolOptions,
): SatiToolDefinition<PaperListSourcesInput, PaperListSourcesOutput> {
  const registry = options.registry;

  return {
    name: "paper_list_sources",
    aliases: ["PaperListSources"],
    description: [
      "- Lists the scholarly literature databases available to search via `paper_search`",
      "- Returns each source's id, name, and description",
      "- Call this first to discover which `db` id to pass to `paper_search`",
    ].join("\n"),
    kind: "network",
    domain: "literature",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        domain: {
          type: "string",
          description: "Optional domain filter (currently only 'literature')",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "paper_list_sources",
        message: "Listing scholarly literature sources requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "paper_list_sources",
        inputSummary: "list paper sources",
        reason: {
          type: "tool",
          toolName: "paper_list_sources",
          message: "Listing scholarly literature sources requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    execute: async (input): Promise<SatiToolExecutionOutput<PaperListSourcesOutput>> => {
      const entries = registry.catalog().filter(e => !input.domain || e.domain === input.domain);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: input.domain
                ? `No literature sources registered for domain "${input.domain}".`
                : "No literature sources are registered.",
            },
          ],
          data: { sources: [], domains: [] },
          metadata: { count: 0, domains: [] },
        };
      }

      const rows = entries.map(e => `- **${e.id}** (${e.name}) — ${e.description}`);
      const domains = [...new Set(entries.map(e => e.domain))];
      return {
        content: [
          { type: "text", text: [`Available literature sources (${entries.length}):`, "", rows.join("\n")].join("\n") },
        ],
        data: { sources: entries, domains },
        metadata: { count: entries.length, domains },
      };
    },
  };
}
