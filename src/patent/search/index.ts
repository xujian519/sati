/**
 * src/patent/search — 检索链路增强 barrel（P0-3）。
 */

export {
  buildRecallPrompt,
  buildRefinedQuery,
  isSearchRecallStatus,
  parseRecallDecision,
  RECALL_SCHEMA,
  type RecallDecision,
  type SearchRecallResult,
  type SearchRecallStatus,
} from "./recall.js";
export {
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_PROVIDER,
  MAX_RERANK_CANDIDATES,
  MAX_SNIPPET_CHARS,
  rerankCandidatesWithModel,
  type LlmRerankOptions,
  type LlmRerankResult,
  type RankedCandidate,
  type RerankCandidate,
  type RerankModelClient,
  type RelevanceTier,
} from "./llm-rerank.js";
