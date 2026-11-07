import type { CanonicalUsage } from "../../model/index.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { buildCompactTokenBudget } from "../../context/budget/compactBudget.js";
import { asPositiveNumber } from "../../shared/configValidators.js";

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
  const inputTokens = asPositiveNumber(latestTurn.inputTokens);
  const outputTokens = asPositiveNumber(latestTurn.outputTokens) ?? 0;
  const cacheReadTokens = asPositiveNumber(latestTurn.cacheReadTokens) ?? 0;
  const cacheWriteTokens = asPositiveNumber(latestTurn.cacheWriteTokens) ?? 0;
  const totalTokens = asPositiveNumber(latestTurn.totalTokens);
  const used =
    inputTokens !== undefined
      ? Math.ceil(inputTokens + cacheReadTokens + cacheWriteTokens)
      : totalTokens !== undefined
        ? Math.max(0, Math.ceil(totalTokens - outputTokens))
        : undefined;
  if (used === undefined || used <= 0) {
    return undefined;
  }
  const total = asPositiveNumber(options.maxContextTokens) ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const reservedOutputTokens = asPositiveNumber(options.maxOutputTokens) ?? 0;
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
    const used = asPositiveNumber(detail.displayUsed) ?? asPositiveNumber(detail.used);
    const total = asPositiveNumber(detail.total);
    const effectiveTotal = asPositiveNumber(detail.effectiveTotal) ?? total;
    if (used === undefined || total === undefined || effectiveTotal === undefined) {
      continue;
    }
    return {
      index,
      usage: {
        used,
        ...(asPositiveNumber(detail.displayUsed) !== undefined
          ? { displayUsed: asPositiveNumber(detail.displayUsed) }
          : {}),
        ...(asPositiveNumber(detail.budgetUsed) !== undefined
          ? { budgetUsed: asPositiveNumber(detail.budgetUsed) }
          : {}),
        ...(asPositiveNumber(detail.fixedOverheadTokens) !== undefined
          ? { fixedOverheadTokens: asPositiveNumber(detail.fixedOverheadTokens) }
          : {}),
        total,
        effectiveTotal,
        reservedOutputTokens: asPositiveNumber(detail.reservedOutputTokens) ?? 0,
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
    const postTokens = asPositiveNumber(metadata.postTokens);
    if (postTokens === undefined) {
      continue;
    }
    return {
      index,
      postTokens,
      ...(asPositiveNumber(metadata.preTokens) !== undefined
        ? { preTokens: asPositiveNumber(metadata.preTokens) }
        : {}),
      ...(asPositiveNumber(metadata.messagesSummarized) !== undefined
        ? { messagesSummarized: asPositiveNumber(metadata.messagesSummarized) }
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
  const fallbackTotal = asPositiveNumber(options.maxContextTokens) ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const fallbackReserved = asPositiveNumber(options.maxOutputTokens) ?? 0;
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
    asPositiveNumber(usage.inputTokens) !== undefined ||
    asPositiveNumber(usage.outputTokens) !== undefined ||
    asPositiveNumber(usage.cacheReadTokens) !== undefined ||
    asPositiveNumber(usage.cacheWriteTokens) !== undefined ||
    asPositiveNumber(usage.totalTokens) !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
