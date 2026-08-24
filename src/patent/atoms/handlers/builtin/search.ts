/**
 * 检索域原子：search（现有技术检索）+ keywords（检索关键词生成）。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from "../../handler.js";
import { callLlm, degraded, parseLlmJson, requireLlm, resolveInputText } from "./llm.js";

/** 查询串预览：超 80 字符截断并加省略号（用于检索结果摘要）。 */
function previewQuery(query: string): string {
  return query.length > 80 ? `${query.slice(0, 80)}…` : query;
}

// ---------------------------------------------------------------------------
// search —— 检索现有技术
// ---------------------------------------------------------------------------

export const searchAtom: Atom = {
  name: "search",
  description: "按查询条件检索现有技术文献，产出文档列表与摘要",
  category: "search",
  inputSchema: ["query", "keywords", "max_results"],
  // 主输出键（outputSchema[0]）为可读文本 search_summary；prior_art 供后续阶段消费。
  outputSchema: ["search_summary", "prior_art"],
};

export class SearchHandler implements StageHandler {
  readonly name = "search";
  readonly category = "search" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    // 查询词：显式 query/search_query 优先；其次 keywords 键——KeywordsHandler
    // 产出的是字符串数组，需 join 为查询串（此前 getStateString 对数组返回空，
    // 导致 disclosure 管线的 search 阶段在原子执行下恒降级）。
    const explicit = resolveInputText(state, ["query", "search_query"], "");
    const query =
      explicit ||
      getStateArray(state, "keywords").map(String).filter(Boolean).join(" ") ||
      getStateString(state, "keywords");
    if (!provider?.search) {
      return degraded("search", "未配置检索器（provider.search 缺失）");
    }
    if (query.trim().length === 0) {
      return degraded("search", "查询条件为空");
    }
    try {
      const maxResults = Number(getStateString(state, "max_results")) || 5;
      const docs = await provider.search(query, { maxResults });
      const summary =
        docs.length > 0
          ? `检索到 ${docs.length} 篇相关文献（查询: ${previewQuery(query)}）`
          : `未检索到相关文献（查询: ${previewQuery(query)}）`;
      return { prior_art: docs, search_summary: summary };
    } catch (err) {
      return degraded("search", `检索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// keywords —— 检索关键词生成（移植 Mady disclosure/keywords.go）
// ---------------------------------------------------------------------------

export const keywordsAtom: Atom = {
  name: "keywords",
  description: "基于技术交底书分析摘要生成专利检索关键词（5-15 个，含上下位与同义词）",
  category: "search",
  inputSchema: ["extraction_result", "source_text"],
  outputSchema: ["keywords"],
};

const KEYWORDS_SCHEMA = {
  type: "object",
  properties: {
    keywords: { type: "array", items: { type: "string" }, description: "检索关键词列表" },
  },
  required: ["keywords"],
} as const;

export class KeywordsHandler implements StageHandler {
  readonly name = "keywords";
  readonly category = "search" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "keywords");
    if (missing) return missing;
    const input = getStateString(state, "extraction_result") || getStateString(state, "source_text");
    if (input.trim().length === 0) {
      return degraded("keywords", "输入为空（state.extraction_result / source_text）");
    }
    const prompt = [
      "你是一个专利检索关键词生成助手。根据技术交底书分析摘要，生成检索关键词。",
      "要求：",
      "- 生成 5-15 个关键词，覆盖技术问题、技术特征、技术效果的核心概念",
      "- 关键词应包含上位概念和下位概念",
      "- 适当包含同义词和近义词以扩大检索覆盖面",
      "- 每个关键词应当简洁（2-8 个字）",
      "- 避免过于宽泛的常规词汇",
      "",
      "【分析摘要】",
      "```",
      input.slice(0, 8000),
      "```",
      "",
      '请严格输出 JSON：{ "keywords": ["关键词1", "关键词2", ...] }',
    ].join("\n");
    const res = await callLlm(provider, "keywords", prompt, { schema: KEYWORDS_SCHEMA, temperature: 0 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      parsed => {
        if (!Array.isArray(parsed.keywords)) return null;
        return { keywords: parsed.keywords.map(String) };
      },
      () => degraded("keywords", "关键词 JSON 解析失败"),
    );
  }
}
