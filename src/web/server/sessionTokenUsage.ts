import type { CanonicalUsage } from "../../model/index.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { buildCompactTokenBudget } from "../../context/budget/compactBudget.js";

/**
 * Token-usage recovery from a session transcript: given the durable entries,
 * reconstruct the context-budget shape shown in the web UI (history replay).
 *
 * Extracted from `readSessionMessages.ts` so the replay path stays a focused
 * message-assembly pipeline and this budget logic keeps its own unit boundary.
 */

export const DEFAULT_HISTORY_CONTEXT_TOKENS = 200_000;

export type HistoryTokenUsageOptions = {
  maxContextTokens?: number;
  maxOutputTokens?: number;
};

type IndexedTokenUsage = {
  index: number;
  usage: Record<string, unknown>;
};

type IndexedCompactBudget = {
  index: number;
  preTokens?: number;
  postTokens: number;
  messagesSummarized?: number;
};

export function tokenUsageFromTranscript(
  entries: AgentTranscriptEntry[],
  options: HistoryTokenUsageOptions,
): Record<string, unknown> | undefined {
  const latestBudget = latestContextBudget(entries);
  const latestCompact = latestCompactBudget(entries);
  if (latestCompact && (!latestBudget || latestCompact.index > latestBudget.index)) {
    return tokenUsageFromCompactBoundary(latestCompact, latestBudget?.usage, options);
  }
  if (latestBudget) {
    return latestBudget.usage;
  }
  const latestTurn = latestTurnUsage(entries);
  if (!latestTurn) {
    return undefined;
  }
  const inputTokens = positiveNumber(latestTurn.inputTokens);
  const outputTokens = positiveNumber(latestTurn.outputTokens) ?? 0;
  const cacheReadTokens = positiveNumber(latestTurn.cacheReadTokens) ?? 0;
  const cacheWriteTokens = positiveNumber(latestTurn.cacheWriteTokens) ?? 0;
  const totalTokens = positiveNumber(latestTurn.totalTokens);
  const used =
    inputTokens !== undefined
      ? Math.ceil(inputTokens + cacheReadTokens + cacheWriteTokens)
      : totalTokens !== undefined
        ? Math.max(0, Math.ceil(totalTokens - outputTokens))
        : undefined;
  if (used === undefined || used <= 0) {
    return undefined;
  }
  const total = positiveNumber(options.maxContextTokens) ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const reservedOutputTokens = positiveNumber(options.maxOutputTokens) ?? 0;
  const effectiveTotal = Math.max(1, total - reservedOutputTokens);
  return {
    used,
    total,
    effectiveTotal,
    reservedOutputTokens,
    source: "history",
    exact: true,
    breakdown: {
      input: inputTokens ?? 0,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      output: outputTokens,
      total: totalTokens ?? Math.ceil(used + outputTokens),
    },
  };
}

function latestContextBudget(entries: AgentTranscriptEntry[]): IndexedTokenUsage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "agent_status_message" || entry.event !== "context_budget") {
      continue;
    }
    const detail = isRecord(entry.detail) ? entry.detail : undefined;
    if (!detail) {
      continue;
    }
    const used = positiveNumber(detail.displayUsed) ?? positiveNumber(detail.used);
    const total = positiveNumber(detail.total);
    const effectiveTotal = positiveNumber(detail.effectiveTotal) ?? total;
    if (used === undefined || total === undefined || effectiveTotal === undefined) {
      continue;
    }
    return {
      index,
      usage: {
        used,
        ...(positiveNumber(detail.displayUsed) !== undefined
          ? { displayUsed: positiveNumber(detail.displayUsed) }
          : {}),
        ...(positiveNumber(detail.budgetUsed) !== undefined ? { budgetUsed: positiveNumber(detail.budgetUsed) } : {}),
        total,
        effectiveTotal,
        reservedOutputTokens: positiveNumber(detail.reservedOutputTokens) ?? 0,
        ...(typeof detail.state === "string" ? { state: detail.state } : {}),
        ...(typeof detail.ratio === "number" && Number.isFinite(detail.ratio) ? { ratio: detail.ratio } : {}),
        source: "history",
        exact: true,
      },
    };
  }
  return undefined;
}

function latestCompactBudget(entries: AgentTranscriptEntry[]): IndexedCompactBudget | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "control_boundary" ||
      entry.boundary.kind !== "compact" ||
      !("subtype" in entry.boundary) ||
      entry.boundary.subtype !== "compact_boundary"
    ) {
      continue;
    }
    const metadata = entry.boundary.compactMetadata;
    const postTokens = positiveNumber(metadata.postTokens);
    if (postTokens === undefined) {
      continue;
    }
    return {
      index,
      postTokens,
      ...(positiveNumber(metadata.preTokens) !== undefined ? { preTokens: positiveNumber(metadata.preTokens) } : {}),
      ...(positiveNumber(metadata.messagesSummarized) !== undefined
        ? { messagesSummarized: positiveNumber(metadata.messagesSummarized) }
        : {}),
    };
  }
  return undefined;
}

function tokenUsageFromCompactBoundary(
  compact: IndexedCompactBudget,
  previousBudget: Record<string, unknown> | undefined,
  options: HistoryTokenUsageOptions,
): Record<string, unknown> {
  const fallbackTotal = positiveNumber(options.maxContextTokens) ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const fallbackReserved = positiveNumber(options.maxOutputTokens) ?? 0;
  const budget = buildCompactTokenBudget(
    {
      postTokens: compact.postTokens,
      preTokens: compact.preTokens,
      messagesSummarized: compact.messagesSummarized,
    },
    previousBudget,
    {
      total: fallbackTotal,
      effectiveTotal: Math.max(1, fallbackTotal - fallbackReserved),
      reservedOutputTokens: fallbackReserved,
    },
  );
  if (!budget) {
    return {};
  }
  return { ...budget, exact: false };
}

function latestTurnUsage(entries: AgentTranscriptEntry[]): CanonicalUsage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "turn_result" && hasPositiveUsage(entry.result.usage)) {
      return entry.result.usage;
    }
  }
  return undefined;
}

function hasPositiveUsage(usage: CanonicalUsage | undefined): boolean {
  if (!usage) return false;
  return (
    positiveNumber(usage.inputTokens) !== undefined ||
    positiveNumber(usage.outputTokens) !== undefined ||
    positiveNumber(usage.cacheReadTokens) !== undefined ||
    positiveNumber(usage.cacheWriteTokens) !== undefined ||
    positiveNumber(usage.totalTokens) !== undefined
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
