/**
 * src/tool/builtin/searchPatentFigure — search_patent_figure 工具。
 *
 * 检索已分析的专利附图：索引由 analyze_patent_figure 分析时自动写入
 * `.sati/figures-index.json`（工作区根相对）。关键词 + 可选向量（embedding）
 * 混合检索，返回最相关附图及其分析结果（附图编号/类型/组件/标号/附图
 * 说明），供撰写说明书时确认技术特征与附图的对应关系——PatentVision
 * 图文对齐思路在检索侧的落地。索引为空时返回引导提示。
 */

import { DEFAULT_FIGURE_INDEX_RELATIVE_PATH, loadFigureIndex } from "../../patent/figure/index-store.js";
import { retrieveFigures, type FigureRetrieveMethod } from "../../patent/figure/retrieve.js";
import type { EmbeddingClient } from "../../model/embedding/index.js";
import type { FigureComponent, FigureType } from "../../patent/figure/types.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import { resolveSatiWorkspacePath } from "./filesystem/pathSafety.js";

export type SearchPatentFigureInput = {
  /** 检索关键词（技术特征/部件名/附图标记；空串 = 按附图编号列出全部已分析附图）。 */
  query: string;
  /** 返回条数上限（默认 5，最大 10）。 */
  limit?: number;
};

export type SearchPatentFigureResultItem = {
  figureNumber: number;
  figureType: FigureType;
  /** 附图图片路径（工作区相对路径）。 */
  imagePath: string;
  /** 相关度 0-1（空查询 = 列表模式，usable ? 1 : 0.5）。 */
  score: number;
  usable: boolean;
  overallDescription: string;
  figureDescription: string;
  components: FigureComponent[];
  warnings: string[];
};

export type SearchPatentFigureOutput = {
  query: string;
  /** 返回条数。 */
  total: number;
  /** 索引内附图总数。 */
  indexedCount: number;
  method: FigureRetrieveMethod;
  /** 非致命说明（向量检索被跳过、关键词无命中按向量返回等）。 */
  note?: string;
  /** 引导提示（空索引/无匹配），无则省略。 */
  hint?: string;
  results: SearchPatentFigureResultItem[];
};

export type CreateSearchPatentFigureToolOptions = {
  /** 可选向量检索端点；缺省时仅关键词检索（本地/云端均可用）。 */
  embeddingClient?: EmbeddingClient;
};

export function createSearchPatentFigureTool(
  options: CreateSearchPatentFigureToolOptions = {},
): SatiToolDefinition<SearchPatentFigureInput, SearchPatentFigureOutput> {
  return {
    name: "search_patent_figure",
    title: "Search Patent Figure",
    description:
      "检索已分析的专利附图（索引由 analyze_patent_figure 分析时自动写入 .sati/figures-index.json）：按技术特征、部件名称或附图标记关键词（配置 embedding 后支持语义相似度）返回最相关附图及其分析结果——附图编号、类型、组件与标号、附图说明。撰写说明书/具体实施方式时用于确认技术特征对应的附图与标记。索引为空时返回提示，需先调用 analyze_patent_figure 分析附图。",
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "检索关键词（技术特征/部件名/附图标记；空串 = 按附图编号列出全部已分析附图）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 10）",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolveSatiWorkspacePath(DEFAULT_FIGURE_INDEX_RELATIVE_PATH, context);
      if (!resolved.ok) {
        throw new SatiToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      let loaded;
      try {
        loaded = await loadFigureIndex(resolved.absolutePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError("tool_execution_failed", `读取附图索引失败：${message}`);
      }

      const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
      const query = input.query ?? "";
      const { hits, method, note } = await retrieveFigures(loaded.entries, query, {
        limit,
        embeddingClient: options.embeddingClient,
      });

      const results: SearchPatentFigureResultItem[] = hits.map(hit => {
        const analysis = hit.entry.analysis;
        return {
          figureNumber: analysis.figureNumber,
          figureType: analysis.figureType,
          imagePath: analysis.imagePath,
          score: hit.score,
          usable: analysis.usable,
          overallDescription: analysis.overallDescription,
          figureDescription: analysis.figureDescription,
          components: analysis.components,
          warnings: analysis.warnings,
        };
      });

      const output: SearchPatentFigureOutput = {
        query,
        total: results.length,
        indexedCount: loaded.entries.length,
        method,
        results,
      };
      if (note) output.note = note;
      if (loaded.warning) output.hint = loaded.warning;
      if (loaded.entries.length === 0) {
        output.hint =
          "附图索引为空：请先调用 analyze_patent_figure 分析附图（分析结果自动写入 .sati/figures-index.json），再检索。";
      } else if (results.length === 0 && query.trim() !== "") {
        output.hint = "未检索到匹配附图，可尝试更换关键词，或先分析更多附图。";
      }

      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: { domain: "patent", method, indexedCount: loaded.entries.length },
      };
    },
  };
}
