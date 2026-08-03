import type { TokenWarningState } from "./TokenBudgetManager.js";

/**
 * Post-compaction token budget reconstruction — the single source of truth
 * for turning a compact boundary's `postTokens` into a context-budget shape.
 *
 * Shared by `readSessionMessages` (history replay, TS) and `sati-bridge`
 * (live UI correction, JS) so the two layers cannot drift apart: thresholds,
 * rounding and field mapping live here and nowhere else.
 */

export type CompactTokenBudget = {
  used: number;
  displayUsed: number;
  budgetUsed: number;
  total: number;
  effectiveTotal: number;
  reservedOutputTokens: number;
  ratio: number;
  state: TokenWarningState;
  source: "compact";
  compacted: true;
  preCompactUsed?: number;
  messagesSummarized?: number;
};

/** Facts sourced from a compact boundary / `compact_completed` detail. */
export type CompactBudgetSource = {
  postTokens: number;
  preTokens?: number;
  messagesSummarized?: number;
};

/** Budget values the caller can provide when the previous budget lacks them. */
export type CompactBudgetFallback = {
  total?: number;
  effectiveTotal?: number;
  reservedOutputTokens?: number;
};

/** Mirrors `TokenBudgetManager` defaults so replay matches live policy. */
export const COMPACT_BLOCKING_RATIO = 0.95;
export const COMPACT_WARNING_RATIO = 0.8;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function compactBudgetState(ratio: number): TokenWarningState {
  if (!Number.isFinite(ratio)) return "ok";
  if (ratio >= COMPACT_BLOCKING_RATIO) return "blocking";
  if (ratio >= COMPACT_WARNING_RATIO) return "warning";
  return "ok";
}

export function buildCompactTokenBudget(
  source: CompactBudgetSource,
  previousBudget: Record<string, unknown> | undefined,
  fallback: CompactBudgetFallback = {},
): CompactTokenBudget | null {
  const postTokens = positiveNumber(source.postTokens);
  if (!postTokens) return null;
  const used = Math.ceil(postTokens);
  const total = positiveNumber(previousBudget?.total) ?? fallback.total;
  const effectiveTotal = positiveNumber(previousBudget?.effectiveTotal) ?? fallback.effectiveTotal ?? total;
  if (!total || !effectiveTotal) return null;
  const reservedOutputTokens =
    positiveNumber(previousBudget?.reservedOutputTokens) ?? fallback.reservedOutputTokens ?? 0;
  const ratio = used / effectiveTotal;
  const preCompactUsed = positiveNumber(source.preTokens);
  const messagesSummarized = positiveNumber(source.messagesSummarized);
  return {
    used,
    displayUsed: used,
    budgetUsed: used,
    total,
    effectiveTotal,
    reservedOutputTokens,
    ratio,
    state: compactBudgetState(ratio),
    source: "compact",
    compacted: true,
    ...(preCompactUsed !== undefined ? { preCompactUsed } : {}),
    ...(messagesSummarized !== undefined ? { messagesSummarized } : {}),
  };
}
