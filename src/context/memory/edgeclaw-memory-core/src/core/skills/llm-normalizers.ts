// llm-extraction 的归一化/校验层（从 llm-extraction.ts 拆出，G6 聚类，逐字搬移）。
// 纯函数：无 IO、无外部状态，可独立单测。Llm*/Raw* 类型 type-only 引自
// llm-extraction.js（编译后擦除，无运行时环）。
import { truncate as truncateBase } from "../utils/text.js";
import type { MemoryRoute, ProjectShortlistCandidate } from "../types.js";
import type {
  LlmDreamCluster,
  LlmDreamFileGlobalPlanProject,
  LlmDreamFileProjectRewriteOutputFile,
  LlmDreamProjectMetaReviewOutput,
  LlmGeneralProjectMetaMergeGroup,
} from "./llm-extraction.js";

// 本地类型（与 llm-extraction.ts 内同名定义逐字一致，非导出）。
type ProviderHeaders = Record<string, string> | undefined;

interface RawProjectMetaReviewPayload {
  should_update?: unknown;
  reason?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// llm-extraction 的截断语义：无省略号、截断后 trim（用于 LLM prompt 与存储，避免多余后缀）
function truncate(value: string, maxLength: number): string {
  return truncateBase(value, maxLength, { ellipsis: false, trim: true });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeHeaders(headers: unknown): ProviderHeaders {
  if (!isRecord(headers)) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeDreamFileProjectId(value: unknown, allowedProjectIds: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized && allowedProjectIds.has(normalized) ? normalized : undefined;
}

function normalizeDreamFileEntryIds(items: unknown, allowedEntryIds: ReadonlySet<string>, maxItems = 200): string[] {
  if (!Array.isArray(items)) return [];
  return Array.from(
    new Set(
      items
        .filter((item): item is string => typeof item === "string")
        .map(item => normalizeWhitespace(item))
        .filter(item => item && allowedEntryIds.has(item)),
    ),
  ).slice(0, maxItems);
}

function normalizeDreamFileProjectStatus(value: unknown): string {
  const normalized = typeof value === "string" ? normalizeWhitespace(value) : "";
  return truncate(normalized || "active", 80);
}

function normalizeDreamFileMergeReason(
  value: unknown,
): "rename" | "alias_equivalence" | "duplicate_formal_project" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value).toLowerCase();
  switch (normalized) {
    case "rename":
    case "alias_equivalence":
    case "duplicate_formal_project":
      return normalized;
    default:
      return undefined;
  }
}

function normalizeDreamFileGlobalPlanProject(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
  allowedProjectIds: ReadonlySet<string>,
  fallbackIndex: number,
): LlmDreamFileGlobalPlanProject | null {
  if (!isRecord(item)) return null;
  const retainedEntryIds = normalizeDreamFileEntryIds(item.retained_entry_ids, allowedEntryIds, 400);
  if (retainedEntryIds.length === 0) return null;
  const planKey =
    typeof item.plan_key === "string"
      ? truncate(normalizeWhitespace(item.plan_key), 120)
      : `dream-plan-${fallbackIndex + 1}`;
  const projectName =
    typeof item.project_name === "string" ? truncate(normalizeWhitespace(item.project_name), 120) : "";
  const description = typeof item.description === "string" ? truncate(normalizeWhitespace(item.description), 320) : "";
  if (!projectName || !description) return null;
  const targetProjectId = normalizeDreamFileProjectId(item.target_project_id, allowedProjectIds);
  const mergeReason = normalizeDreamFileMergeReason(item.merge_reason);
  return {
    planKey,
    ...(targetProjectId ? { targetProjectId } : {}),
    projectName,
    description,
    status: normalizeDreamFileProjectStatus(item.status),
    ...(mergeReason ? { mergeReason } : {}),
    evidenceEntryIds: normalizeDreamFileEntryIds(item.evidence_entry_ids, allowedEntryIds, 80),
    retainedEntryIds,
  };
}

function normalizeDreamFileProjectMetaPayload(
  value: unknown,
  fallback: { projectName: string; description: string; status: string },
): { projectName: string; description: string; status: string } {
  if (!isRecord(value)) return fallback;
  const projectName =
    typeof value.project_name === "string"
      ? truncate(normalizeWhitespace(value.project_name), 120)
      : fallback.projectName;
  const description =
    typeof value.description === "string"
      ? truncate(normalizeWhitespace(value.description), 320)
      : fallback.description;
  return {
    projectName: projectName || fallback.projectName,
    description: description || fallback.description,
    status: normalizeDreamFileProjectStatus(value.status ?? fallback.status),
  };
}

function normalizeDreamFileProjectRewriteFile(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
): LlmDreamFileProjectRewriteOutputFile | null {
  if (!isRecord(item)) return null;
  const type = item.type === "project" || item.type === "feedback" ? item.type : null;
  if (!type) return null;
  const sourceEntryIds = normalizeDreamFileEntryIds(item.source_entry_ids, allowedEntryIds, 200);
  if (sourceEntryIds.length === 0) return null;
  const name = typeof item.name === "string" ? truncate(normalizeWhitespace(item.name), 120) : "";
  const description = typeof item.description === "string" ? truncate(normalizeWhitespace(item.description), 320) : "";
  if (!name || !description) return null;
  if (type === "project") {
    const stage = typeof item.stage === "string" ? truncate(normalizeWhitespace(item.stage), 220) : "";
    return {
      type,
      name,
      description,
      sourceEntryIds,
      ...(stage ? { stage } : {}),
      decisions: uniqueStrings(normalizeStringArray(item.decisions, 20), 20),
      constraints: uniqueStrings(normalizeStringArray(item.constraints, 20), 20),
      nextSteps: uniqueStrings(normalizeStringArray(item.next_steps, 20), 20),
      blockers: uniqueStrings(normalizeStringArray(item.blockers, 20), 20),
      timeline: uniqueStrings(normalizeStringArray(item.timeline, 20), 20),
      notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
    };
  }
  const rule = typeof item.rule === "string" ? truncate(normalizeWhitespace(item.rule), 320) : "";
  if (!rule) return null;
  return {
    type,
    name,
    description,
    sourceEntryIds,
    rule,
    ...(typeof item.why === "string" && normalizeWhitespace(item.why)
      ? { why: truncate(normalizeWhitespace(item.why), 320) }
      : {}),
    ...(typeof item.how_to_apply === "string" && normalizeWhitespace(item.how_to_apply)
      ? { howToApply: truncate(normalizeWhitespace(item.how_to_apply), 320) }
      : {}),
    notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
  };
}

function normalizeDreamCluster(item: unknown, allowedRelativePaths: ReadonlySet<string>): LlmDreamCluster | null {
  if (!isRecord(item)) return null;
  const memberRelativePaths = normalizeDreamFileEntryIds(item.member_relative_paths, allowedRelativePaths, 32);
  if (memberRelativePaths.length === 0) return null;
  const reason = typeof item.reason === "string" ? truncate(normalizeWhitespace(item.reason), 320) : "";
  return {
    memberRelativePaths,
    reason,
  };
}

function normalizeGeneralProjectMetaMergeGroup(item: unknown): LlmGeneralProjectMetaMergeGroup | null {
  if (!isRecord(item)) return null;
  const keeperProjectId = typeof item.keeper_project_id === "string" ? normalizeWhitespace(item.keeper_project_id) : "";
  const duplicateProjectIds = normalizeStringArray(item.duplicate_project_ids, 100)
    .map(projectId => normalizeWhitespace(projectId))
    .filter(Boolean);
  if (!keeperProjectId || duplicateProjectIds.length === 0) return null;
  const reason = typeof item.reason === "string" ? truncate(normalizeWhitespace(item.reason), 320) : "";
  return {
    keeperProjectId,
    duplicateProjectIds: Array.from(new Set(duplicateProjectIds)),
    reason,
  };
}

function normalizeDreamProjectMetaReview(
  payload: RawProjectMetaReviewPayload,
  fallback: { projectName: string; description: string; status: string },
): LlmDreamProjectMetaReviewOutput {
  return {
    shouldUpdate: normalizeBoolean(payload.should_update, false),
    reason: typeof payload.reason === "string" ? truncate(normalizeWhitespace(payload.reason), 320) : "",
    projectMeta: {
      projectName:
        typeof payload.project_name === "string"
          ? truncate(normalizeWhitespace(payload.project_name), 120) || fallback.projectName
          : fallback.projectName,
      description:
        typeof payload.description === "string"
          ? truncate(normalizeWhitespace(payload.description), 320) || fallback.description
          : fallback.description,
      status: normalizeDreamFileProjectStatus(payload.status ?? fallback.status),
    },
  };
}

function truncateForPrompt(value: string, maxLength: number): string {
  return truncate(normalizeWhitespace(value), maxLength);
}

function recallProjectSourcePriority(project: ProjectShortlistCandidate): number {
  if (project.sourceType === "general_local" || project.sourceType === "workspace_external_mirror") return 2;
  if (project.sourceType === "workspace_external") return 1;
  return 0;
}

function chooseBestRecallProjectFallback(shortlist: ProjectShortlistCandidate[]): ProjectShortlistCandidate {
  return (
    [...shortlist].sort((left, right) => {
      if (right.exact !== left.exact) return right.exact - left.exact;
      if (right.score !== left.score) return right.score - left.score;
      const sourcePriorityDelta = recallProjectSourcePriority(right) - recallProjectSourcePriority(left);
      if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
      return right.updatedAt.localeCompare(left.updatedAt);
    })[0] ?? shortlist[0]
  );
}

function normalizeStringArray(items: unknown, maxItems: number): string[] {
  if (typeof items === "string" && items.trim()) {
    return [items.trim()].slice(0, maxItems);
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueStrings(items: readonly string[], maxItems: number): string[] {
  return Array.from(new Set(items.map(item => item.trim()).filter(Boolean))).slice(0, maxItems);
}

function normalizeMemoryRoute(value: unknown): MemoryRoute {
  if (value === "user" || value === "project" || value === "mix" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

export {
  chooseBestRecallProjectFallback,
  clampConfidence,
  isRecord,
  normalizeBoolean,
  normalizeDreamCluster,
  normalizeDreamFileEntryIds,
  normalizeDreamFileGlobalPlanProject,
  normalizeDreamFileMergeReason,
  normalizeDreamFileProjectId,
  normalizeDreamFileProjectMetaPayload,
  normalizeDreamFileProjectRewriteFile,
  normalizeDreamFileProjectStatus,
  normalizeDreamProjectMetaReview,
  normalizeGeneralProjectMetaMergeGroup,
  normalizeMemoryRoute,
  normalizeStringArray,
  normalizeWhitespace,
  sanitizeHeaders,
  stripTrailingSlash,
  truncate,
  truncateForPrompt,
  uniqueStrings,
};
