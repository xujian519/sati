/**
 * src/patent/search — 检索链路增强（P0-3 LLM 摘要精排）。
 *
 * 与 cross-encoder rerank（src/model/embedding/rerank.ts，需外部 TEI/oMLX 端点）
 * 互补：本模块用**会话主模型**对候选摘要打相关性档位，零外部部署即可用，
 * 决策背景见 docs/notes/implemented/2026-09-29-patent-candidate-llm-rerank.md。
 */

import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import { tryParseJson } from "../llm-json.js";

/** 工具层可注入的最小模型客户端形状（对齐 SatiToolModelClient）。 */
export type RerankModelClient = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

/** 默认模型（对齐 figure 域：moonshot/kimi-k3；会话模型可用时优先继承会话模型）。 */
export const DEFAULT_RERANK_PROVIDER = "moonshot";
export const DEFAULT_RERANK_MODEL = "kimi-k3";

/** 单次精排候选上限（超出截断并标记 truncated）。 */
export const MAX_RERANK_CANDIDATES = 20;

/** 单条摘要送入 prompt 的截断长度（字符）。 */
export const MAX_SNIPPET_CHARS = 400;
/** 检索式与标题的输入上限（与摘要截断同一风格：显式截断，不静默拒收）。 */
const MAX_QUERY_CHARS = 600;
const MAX_TITLE_CHARS = 200;

export type RerankCandidate = {
  /** 候选主键（公开号 / URL / 本地库 id，调用方保证唯一）。 */
  id: string;
  title: string;
  snippet?: string;
  publicationDate?: string;
};

/** 相关性档位：3=高相关(>80%)，2=中相关(50-80%)，1=低相关，0=无关。 */
export type RelevanceTier = 0 | 1 | 2 | 3;

export type RankedCandidate = {
  id: string;
  tier: RelevanceTier;
  reason?: string;
};

export type LlmRerankOptions = {
  provider?: string;
  model?: string;
  /** 参与精排的候选上限（默认 20；超出取前 N 条，其余按未评级原序附尾）。 */
  maxCandidates?: number;
  /** 输出 token 预算（thinking 模型需为思考预留，默认 4000）。 */
  maxOutputTokens?: number;
  /** JSON 解析失败的修复重试次数（默认 1）。 */
  maxRepairRetries?: number;
  signal?: AbortSignal;
};

export type LlmRerankResult = {
  /** 按档位降序 + 模型给出顺序排列的结果（含未被模型评级的候选，tier=0 置尾）。 */
  ranked: RankedCandidate[];
  /** 精排是否降级（模型缺失/调用失败/解析终失败 → 原序 + degraded）。 */
  degraded: boolean;
  /** 降级原因（degraded=true 时有值）。 */
  degradeReason?: string;
  /** 实际参与精排的候选数。 */
  rerankedCount: number;
  /** 因超出 maxCandidates 被跳过的候选数。 */
  truncatedCount: number;
};

function tierValue(value: unknown): RelevanceTier | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 3) return undefined;
  return n as RelevanceTier;
}

function buildPrompt(query: string, candidates: RerankCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const title = c.title.length > MAX_TITLE_CHARS ? `${c.title.slice(0, MAX_TITLE_CHARS)}…` : c.title;
    const snippet =
      c.snippet !== undefined && c.snippet.trim() !== ""
        ? ` | 摘要：${c.snippet.trim().slice(0, MAX_SNIPPET_CHARS)}`
        : "";
    const date = c.publicationDate ? ` | 公开日：${c.publicationDate}` : "";
    return `${i + 1}. id=${c.id} | 标题：${title}${date}${snippet}`;
  });
  return [
    "你是专利查新检索的相关性精排专家。给定一个技术 query 和若干候选文献（专利/论文），",
    "逐条判断 query 技术方案与候选的技术相关性，输出 JSON 对象。",
    "档位定义：3=高相关（技术方案实质相同或高度相似，>80%）；2=中相关（公开部分核心特征，50-80%）；",
    "1=低相关（同领域但方案不同）；0=无关。",
    "规则：只输出 JSON（不要代码围栏）；每条候选必须评级；reason 用一句中文给出判定依据（对应/缺失的技术特征）。",
    '[SCHEMA] {"results": [{"id": "候选id原样返回", "tier": 0-3, "reason": "…"}]}',
    "[QUERY]",
    query.slice(0, MAX_QUERY_CHARS),
    "[CANDIDATES]",
    ...lines,
  ].join("\n");
}

function buildRequest(
  prompt: string,
  opts: Required<Pick<LlmRerankOptions, "provider" | "model" | "maxOutputTokens">>,
): CanonicalModelRequest {
  return {
    provider: opts.provider,
    model: opts.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    maxOutputTokens: opts.maxOutputTokens,
    // temperature 不传：thinking 模型（kimi-k3 等）仅接受 1，由模型层决定。
    stream: true,
    metadata: { tool: "patent_candidate_rerank" },
  };
}

async function collectText(
  client: RerankModelClient,
  request: CanonicalModelRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  let text = "";
  for await (const event of client.stream(request, signal)) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "error") throw new Error(event.error?.message ?? "模型调用失败");
  }
  return text.trim();
}

/** 模型输出 → 评级表（容忍对象包裹 {results:[…]} 与裸数组两种形态；非法条目丢弃）。 */
function parseRanks(raw: string, validIds: Set<string>): Map<string, RankedCandidate> | undefined {
  const wrapped = tryParseJson(raw);
  let array: unknown = Array.isArray(wrapped?.results) ? wrapped?.results : undefined;
  if (array === undefined) {
    // 裸数组形态 tryParseJson 不返回（只认对象）：直接 JSON.parse 尝试。
    try {
      const direct = JSON.parse(raw);
      array = Array.isArray(direct)
        ? direct
        : Array.isArray((direct as { results?: unknown }).results)
          ? (direct as { results: unknown[] }).results
          : undefined;
    } catch {
      // 整段直接解析失败：下面改试代码围栏内嵌 JSON，仍不成则返回未解析（调用方走降级）。
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
      if (fenced !== null) {
        try {
          const inner = JSON.parse(fenced[1]!);
          array = Array.isArray(inner) ? inner : (inner as { results?: unknown[] }).results;
        } catch {
          // 围栏内也非法 JSON：保持 array undefined，下游按未解析走修复/降级。
          array = undefined;
        }
      }
    }
  }
  if (!Array.isArray(array)) return undefined;
  const ranks = new Map<string, RankedCandidate>();
  for (const item of array) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { id?: unknown; tier?: unknown; reason?: unknown };
    if (typeof entry.id !== "string" || !validIds.has(entry.id)) continue;
    const tier = tierValue(entry.tier);
    if (tier === undefined) continue;
    ranks.set(entry.id, {
      id: entry.id,
      tier,
      ...(typeof entry.reason === "string" && entry.reason.trim() !== "" ? { reason: entry.reason.trim() } : {}),
    });
  }
  return ranks.size > 0 ? ranks : undefined;
}

function degrade(reason: string, candidates: RerankCandidate[], truncated: number): LlmRerankResult {
  return {
    ranked: candidates.map(c => ({ id: c.id, tier: 0 as RelevanceTier })),
    degraded: true,
    degradeReason: reason,
    rerankedCount: 0,
    truncatedCount: truncated,
  };
}

/**
 * LLM 摘要精排：一次批量调用对候选打相关性档位（对齐 patent-prior-art-search
 * 第三步的高/中/低相关分档）。任何失败路径**不阻断**：降级为原序 + degraded=true
 * （对齐"语义检索失败自动降级关键词检索"的既有规范）。
 */
export async function rerankCandidatesWithModel(
  client: RerankModelClient | undefined,
  query: string,
  candidates: RerankCandidate[],
  options: LlmRerankOptions = {},
): Promise<LlmRerankResult> {
  const cap = options.maxCandidates ?? MAX_RERANK_CANDIDATES;
  if (candidates.length === 0) {
    return { ranked: [], degraded: false, rerankedCount: 0, truncatedCount: 0 };
  }
  const head = candidates.slice(0, cap);
  const tail = candidates.slice(cap);
  const truncated = tail.length;
  if (client === undefined) {
    return degrade("模型客户端不可用", candidates, truncated);
  }
  if (query.trim() === "") {
    return degrade("query 为空，无法精排", candidates, truncated);
  }

  const buildOpts = {
    provider: options.provider ?? DEFAULT_RERANK_PROVIDER,
    model: options.model ?? DEFAULT_RERANK_MODEL,
    maxOutputTokens: options.maxOutputTokens ?? 4000,
  };
  const prompt = buildPrompt(query, head);
  const validIds = new Set(head.map(c => c.id));
  const maxRepairs = options.maxRepairRetries ?? 1;

  let ranks: Map<string, RankedCandidate> | undefined;
  let lastError = "";
  let attempts = 0;
  let currentPrompt = prompt;
  let previousRaw = "";
  while (attempts <= maxRepairs) {
    attempts += 1;
    try {
      const raw = await collectText(client, buildRequest(currentPrompt, buildOpts), options.signal);
      ranks = parseRanks(raw, validIds);
      if (ranks !== undefined) break;
      // 解析失败：带 schema 的修复重试（对齐 figure 域 repair prompt 模式）；已取消则不再重试。
      lastError = "模型输出不是可解析的评级 JSON";
      previousRaw = raw;
      if (options.signal?.aborted === true || attempts > maxRepairs) break;
      currentPrompt = `${prompt}\n\n[注意] 上次输出无法解析为 JSON。请严格只输出 [SCHEMA] 定义的 JSON 对象，不要任何额外文本。上次输出前 500 字：\n${previousRaw.slice(0, 500)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted === true || attempts > maxRepairs) break;
      currentPrompt = prompt;
    }
  }

  if (ranks === undefined) {
    return degrade(lastError || "精排失败", candidates, truncated);
  }

  // 组装：head 中模型评过级的按档位降序（同级保持模型顺序），未评级的按原序置尾 tier=0；
  // tail（超上限被跳过的）保持原序附后 tier=0，不静默丢弃。
  const rankedHead: RankedCandidate[] = [];
  const unrated: RankedCandidate[] = [];
  for (const c of head) {
    const rank = ranks.get(c.id);
    if (rank !== undefined) rankedHead.push(rank);
    else unrated.push({ id: c.id, tier: 0 });
  }
  rankedHead.sort((a, b) => b.tier - a.tier);
  const ranked = [...rankedHead, ...unrated, ...tail.map(c => ({ id: c.id, tier: 0 as const }))];
  return { ranked, degraded: false, rerankedCount: rankedHead.length, truncatedCount: truncated };
}
