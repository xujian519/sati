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
import { dataBlock } from "../../../prompt-hygiene.js";
import {
  buildRecallPrompt,
  buildRefinedQuery,
  parseRecallDecision,
  RECALL_SCHEMA,
  type RecallDecision,
} from "../../../search/recall.js";
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
// search-recall —— 有界补检（撰写清单专用：覆盖不足时换检索式再查）
// ---------------------------------------------------------------------------

/** 补检轮次缺省值（与创造性图的 retrieval.maxRounds 缺省一致）。 */
export const DEFAULT_RETRIEVAL_ROUNDS = 2;

export type SearchRecallStatus = "adequate" | "uncovered" | "not_evaluated" | "single_pass";

export type SearchRecallResult = {
  status: SearchRecallStatus;
  /** 实际执行的补检次数（不含首轮）。 */
  rounds: number;
  missingFeatures: string[];
  reason?: string;
};

export const searchRecallAtom: Atom = {
  name: "search-recall",
  description: "检索现有技术并在特征未被覆盖时有界补检（轮次用尽仍缺则标记未覆盖，不假装通过）",
  category: "search",
  inputSchema: ["query", "keywords", "features", "max_results", "retrieval_rounds"],
  outputSchema: ["search_summary", "prior_art", "search_recall"],
};

function readRetrievalRounds(state: PipelineState): number {
  // 注意：getStateString 对数字返回空串，必须先看原始值，否则参数 0 会落回默认 2。
  const raw = state.retrieval_rounds;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  const parsed = Number.parseInt(getStateString(state, "retrieval_rounds"), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRIEVAL_ROUNDS;
}

function resolveQuery(state: PipelineState): string {
  const explicit = getStateString(state, "query") || getStateString(state, "search_query");
  if (explicit.trim().length > 0) return explicit.trim();
  return getStateArray(state, "keywords").map(String).filter(Boolean).join(" ").trim();
}

function asDocRecord(doc: unknown): Record<string, unknown> | undefined {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
}

/** 去重键：优先 url；没有 url 时用 title + snippet（provider.search 的文档没有稳定 id）。 */
function docKey(doc: unknown): string {
  const record = asDocRecord(doc);
  const url = typeof record?.url === "string" ? record.url.trim() : "";
  if (url.length > 0) return `url:${url}`;
  const title = typeof record?.title === "string" ? record.title : "";
  const snippet = typeof record?.snippet === "string" ? record.snippet : "";
  return `title:${title}|snippet:${snippet}`;
}

function mergeDocs(existing: readonly unknown[], incoming: readonly unknown[]): unknown[] {
  const seen = new Set(existing.map(docKey));
  const merged = [...existing];
  for (const doc of incoming) {
    const key = docKey(doc);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }
  return merged;
}

function formatDocs(docs: readonly unknown[]): string {
  return docs
    .map((doc, index) => {
      const record = asDocRecord(doc);
      const parts = [record?.title, record?.snippet, record?.publication_date, record?.url]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" | ");
      return `${index + 1}. ${parts}`;
    })
    .join("\n");
}

export class SearchRecallHandler implements StageHandler {
  readonly name = "search-recall";
  readonly category = "search" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const query = resolveQuery(state);
    const features = getStateArray(state, "features").map(String).filter(Boolean);
    const maxResults = Number(getStateString(state, "max_results")) || 5;

    if (!provider?.search) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: 0,
        missingFeatures: [],
        reason: "未配置检索器（provider.search 缺失）",
      };
      return {
        prior_art: [],
        search_summary: `检索未执行：${recall.reason}`,
        search_recall: JSON.stringify(recall),
      };
    }
    if (query.length === 0) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: 0,
        missingFeatures: [],
        reason: "查询条件为空",
      };
      return {
        prior_art: [],
        search_summary: `检索未执行：${recall.reason}`,
        search_recall: JSON.stringify(recall),
      };
    }

    let docs: unknown[] = [];
    try {
      docs = await provider.search(query, { maxResults });
    } catch (err) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: 0,
        missingFeatures: [],
        reason: `检索失败: ${err instanceof Error ? err.message : String(err)}`,
      };
      return {
        prior_art: [],
        search_summary: `检索失败：${recall.reason}`,
        search_recall: JSON.stringify(recall),
      };
    }

    const firstRoundSummary = `检索到 ${docs.length} 篇相关文献（查询: ${previewQuery(query)}）`;

    if (features.length === 0) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: 0,
        missingFeatures: [],
        reason: "无特征清单，补检未执行",
      };
      return {
        prior_art: docs,
        search_summary: `${firstRoundSummary}；无特征清单，补检未执行`,
        search_recall: JSON.stringify(recall),
      };
    }

    const maxRounds = readRetrievalRounds(state);
    if (maxRounds === 0) {
      const recall: SearchRecallResult = { status: "single_pass", rounds: 0, missingFeatures: [] };
      return {
        prior_art: docs,
        search_summary: firstRoundSummary,
        search_recall: JSON.stringify(recall),
      };
    }

    if (!provider.callLLM) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: 0,
        missingFeatures: [],
        reason: "未配置 LLM，无法判断检索覆盖度",
      };
      return {
        prior_art: docs,
        search_summary: `${firstRoundSummary}；未配置 LLM，覆盖度未评估`,
        search_recall: JSON.stringify(recall),
      };
    }

    let currentQuery = query;
    let decision: RecallDecision | undefined;
    let usedRounds = 0;

    const judge = async (): Promise<RecallDecision | undefined> => {
      try {
        const raw = await provider.callLLM!(
          buildRecallPrompt({ parse: features.join("；"), priorArtText: formatDocs(docs) }),
          {
            jsonSchema: RECALL_SCHEMA,
          },
        );
        return parseRecallDecision(raw);
      } catch {
        // 召回判断失败按 not_evaluated 处理，不能当作 adequate。
        return undefined;
      }
    };

    decision = await judge();
    while (decision !== undefined && !decision.adequate && usedRounds < maxRounds) {
      const nextQuery = buildRefinedQuery(currentQuery, decision.missing_features);
      const more = await provider.search(nextQuery, { maxResults });
      docs = mergeDocs(docs, Array.isArray(more) ? more : []);
      currentQuery = nextQuery;
      usedRounds += 1;
      decision = await judge();
    }

    if (decision === undefined) {
      const recall: SearchRecallResult = {
        status: "not_evaluated",
        rounds: usedRounds,
        missingFeatures: [],
        reason: "覆盖度判断失败（模型输出不可解析），补检未完成",
      };
      return {
        prior_art: docs,
        search_summary: `${firstRoundSummary}；覆盖度未评估`,
        search_recall: JSON.stringify(recall),
      };
    }

    if (decision.adequate) {
      const recall: SearchRecallResult = {
        status: "adequate",
        rounds: usedRounds,
        missingFeatures: [],
      };
      return {
        prior_art: docs,
        search_summary: `${firstRoundSummary}；补检 ${usedRounds} 轮后覆盖核心技术特征`,
        search_recall: JSON.stringify(recall),
      };
    }

    const recall: SearchRecallResult = {
      status: "uncovered",
      rounds: usedRounds,
      missingFeatures: decision.missing_features,
      reason: `补检 ${usedRounds} 轮后仍有特征未被覆盖`,
    };
    return {
      prior_art: docs,
      search_summary: `${firstRoundSummary}；仍有特征未被覆盖：${decision.missing_features.join("、") || "（未列出）"}`,
      search_recall: JSON.stringify(recall),
    };
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
      dataBlock(input.slice(0, 8000)),
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
