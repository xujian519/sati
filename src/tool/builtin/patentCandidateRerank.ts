import {
  MAX_RERANK_CANDIDATES,
  rerankCandidatesWithModel,
  type LlmRerankResult,
  type RerankCandidate,
  type RerankModelClient,
} from "../../patent/index.js";
import type { SatiJsonSchema } from "../protocol/schema.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * `patent_candidate_rerank` — 检索候选 LLM 摘要精排（P0-3）。
 *
 * 查新/无效证据收集的"筛选与排序"步骤（对齐 patent-prior-art-search 第三步的
 * 高/中/低相关分档）：把候选（公开号/标题/摘要）一次批量交给模型打相关性档位，
 * 补 cross-encoder rerank 端点（需外部部署）之外的零配置精排通道。
 * 任何失败路径降级为原序 + degraded=true，不阻断检索流程。
 */

export type CandidateRerankToolInput = {
  /** 技术 query（待评价的技术方案描述）。 */
  query: string;
  /** 检索候选（≤20 条参与精排，超出取前 N 条并按未评级置尾）。 */
  candidates: Array<{ id: string; title: string; snippet?: string; publicationDate?: string }>;
  /** 返回条数上限（可选；缺省返回全部含档位）。 */
  topK?: number;
};

export type CandidateRerankToolDeps = {
  /** 精排实现注入（测试用；缺省 rerankCandidatesWithModel）。 */
  rerank?: typeof rerankCandidatesWithModel;
  /** 模型客户端覆盖（缺省 context.model）。 */
  model?: RerankModelClient;
};

const CANDIDATE_SCHEMA: SatiJsonSchema = {
  type: "object",
  required: ["id", "title"],
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "候选键（公开号/URL/本地 id），须唯一" },
    title: { type: "string", description: "Title." },
    snippet: { type: "string", description: "Abstract or snippet (~400 chars)." },
    publicationDate: { type: "string", description: "公开日（ISO），用于时间有效性判断" },
  },
};

export function createPatentCandidateRerankTool(
  deps: CandidateRerankToolDeps = {},
): SatiToolDefinition<CandidateRerankToolInput, LlmRerankResult> {
  const rerank = deps.rerank ?? rerankCandidatesWithModel;
  return {
    name: "patent_candidate_rerank",
    title: "Rerank Patent Search Candidates",
    description:
      "Read-only: reranks search candidates by relevance tier + reasons; model missing → original order " +
      "(degraded, not blocking). 详见 skills/patent-illustrator/references/patent-tool-contracts/workflow.md。",
    kind: "custom",
    domain: "patent",
    aliases: ["PatentCandidateRerank", "candidate_rerank"],
    inputSchema: {
      type: "object",
      required: ["query", "candidates"],
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "技术方案描述（相关性判定基准）。" },
        candidates: {
          type: "array",
          description: `检索候选（≤${MAX_RERANK_CANDIDATES} 条参与精排）。`,
          items: CANDIDATE_SCHEMA,
        },
        topK: { type: "number", description: "返回条数上限（可选，缺省全部）。" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ranked", "degraded", "rerankedCount", "truncatedCount"],
      properties: {
        ranked: { type: "array" },
        degraded: { type: "boolean" },
        degradeReason: { type: "string" },
        rerankedCount: { type: "number" },
        truncatedCount: { type: "number" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      const candidates: RerankCandidate[] = (input.candidates ?? []).map(c => ({
        id: c.id,
        title: c.title,
        ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
        ...(c.publicationDate !== undefined ? { publicationDate: c.publicationDate } : {}),
      }));
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: "patent_candidate_rerank: candidates 为空，无候选可精排。" }],
          data: { ranked: [], degraded: false, rerankedCount: 0, truncatedCount: 0 },
        };
      }
      const model = deps.model ?? context.model;
      const result = await rerank(model, input.query, candidates, {
        ...(context.provider !== undefined ? { provider: context.provider } : {}),
        ...(context.modelId !== undefined ? { model: context.modelId } : {}),
        signal: context.abortSignal,
      });
      const limited = input.topK !== undefined && input.topK > 0 ? result.ranked.slice(0, input.topK) : result.ranked;
      const lines = limited.map((r, i) => {
        const flag = r.tier >= 3 ? "高相关" : r.tier === 2 ? "中相关" : r.tier === 1 ? "低相关" : "未评级/无关";
        const reason = r.reason !== undefined ? ` — ${r.reason}` : "";
        return `${i + 1}. [${flag}] ${r.id}${reason}`;
      });
      const header = result.degraded
        ? `精排降级（${result.degradeReason ?? "未知原因"}）：保持原序，全部按未评级返回。`
        : `精排完成：${result.rerankedCount} 条评级${result.truncatedCount > 0 ? `，${result.truncatedCount} 条超出上限未参与精排` : ""}。`;
      return {
        content: [{ type: "text", text: [`patent_candidate_rerank: ${header}`, ...lines].join("\n") }],
        data: { ...result, ranked: limited },
        metadata: {
          degraded: result.degraded,
          rerankedCount: result.rerankedCount,
          truncatedCount: result.truncatedCount,
        },
      };
    },
  };
}
