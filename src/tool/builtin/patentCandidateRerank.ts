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
    id: { type: "string", description: "Candidate key (publication number / URL / local id), unique." },
    title: { type: "string", description: "Title." },
    snippet: { type: "string", description: "Abstract or relevant snippet (truncated to ~400 chars for ranking)." },
    publicationDate: { type: "string", description: "Publication date (ISO), for time-validity context." },
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
      "对专利/文献检索候选做 LLM 摘要精排：一次批量调用给每条候选打相关性档位" +
      "（3=高相关>80%，2=中相关50-80%，1=低相关，0=无关）并给出中文判定理由。" +
      "用于查新检索与无效证据收集的筛选排序步骤，替代人工逐条初筛。最多 20 条参与精排，" +
      "超出按未评级置尾（truncatedCount 透出）。模型不可用或输出解析失败时降级返回原序" +
      "（degraded=true），不阻断检索流程。不改变候选集合本身，只输出排序与档位。",
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
