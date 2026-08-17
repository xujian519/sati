// file-memory 的 manifest/项目元数据（从 file-memory.ts 拆出，逐字搬移）。
// 候选合并/同源判定/排序 + manifest 渲染 + project.meta 解析渲染。
import { existsSync, readFileSync } from "node:fs";
import { nowIso } from "./utils/id.js";
import { CURRENT_PROJECT_ID, DEFAULT_PROJECT_STATUS, PROJECT_META_FILE } from "./file-constants.js";
import { normalizeDescription, normalizeWhitespace, splitLines, uniqueStrings } from "./file-text.js";
import { parseFrontmatterBlock } from "./file-markdown.js";
import type { GeneralProjectSourceKind, MemoryCandidate, MemoryManifestEntry, ProjectMetaRecord } from "./types.js";

function mergeCandidates(primary: MemoryCandidate, incoming: MemoryCandidate): MemoryCandidate {
  if (primary.type !== incoming.type) return primary;
  if (primary.type === "user") {
    return {
      ...primary,
      profile: normalizeWhitespace(incoming.profile || primary.profile || primary.description || incoming.description),
      preferences: uniqueStrings([...(primary.preferences ?? []), ...(incoming.preferences ?? [])]),
      constraints: uniqueStrings([...(primary.constraints ?? []), ...(incoming.constraints ?? [])]),
      relationships: uniqueStrings([...(primary.relationships ?? []), ...(incoming.relationships ?? [])]),
      description: normalizeDescription(incoming.description, primary.description),
    };
  }
  if (primary.type === "feedback") {
    return {
      ...primary,
      name: normalizeWhitespace(incoming.name || primary.name),
      description: normalizeDescription(incoming.description, primary.description),
      rule: normalizeWhitespace(incoming.rule || primary.rule || incoming.description || primary.description),
      why: normalizeWhitespace(incoming.why || primary.why),
      howToApply: normalizeWhitespace(incoming.howToApply || primary.howToApply),
      notes: uniqueStrings([...(primary.notes ?? []), ...(incoming.notes ?? [])]),
    };
  }
  if (primary.type === "general_project_meta") {
    return {
      ...primary,
      projectId: normalizeWhitespace(incoming.projectId || primary.projectId),
      name: normalizeWhitespace(incoming.name || primary.name),
      description: normalizeDescription(incoming.description, primary.description),
      stage: normalizeWhitespace(incoming.stage || primary.stage),
      ...((incoming as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind
        ? { sourceKind: (incoming as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind }
        : (primary as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind
          ? { sourceKind: (primary as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind }
          : {}),
      ...((incoming as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath
        ? { sourceWorkspacePath: (incoming as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath }
        : (primary as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath
          ? { sourceWorkspacePath: (primary as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath }
          : {}),
      ...((incoming as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId
        ? { sourceProjectId: (incoming as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId }
        : (primary as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId
          ? { sourceProjectId: (primary as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId }
          : {}),
    };
  }
  return {
    ...primary,
    name: normalizeWhitespace(incoming.name || primary.name),
    description: normalizeDescription(incoming.description, primary.description),
    summary: normalizeWhitespace(incoming.summary || primary.summary),
    stage: normalizeWhitespace(incoming.stage || primary.stage),
    decisions: uniqueStrings([...(primary.decisions ?? []), ...(incoming.decisions ?? [])]),
    constraints: uniqueStrings([...(primary.constraints ?? []), ...(incoming.constraints ?? [])]),
    nextSteps: uniqueStrings([...(primary.nextSteps ?? []), ...(incoming.nextSteps ?? [])]),
    blockers: uniqueStrings([...(primary.blockers ?? []), ...(incoming.blockers ?? [])]),
    timeline: uniqueStrings([...(primary.timeline ?? []), ...(incoming.timeline ?? [])]),
    notes: uniqueStrings([...(primary.notes ?? []), ...(incoming.notes ?? [])]),
  };
}

function sameOrigin(record: MemoryManifestEntry, candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.capturedAt &&
      candidate.sourceSessionKey &&
      record.capturedAt === candidate.capturedAt &&
      record.sourceSessionKey === candidate.sourceSessionKey &&
      record.type === candidate.type,
  );
}

function sortEntries(entries: MemoryManifestEntry[]): MemoryManifestEntry[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function renderManifestSection(
  title: string,
  entries: MemoryManifestEntry[],
  linkResolver?: (entry: MemoryManifestEntry) => string,
): string[] {
  if (entries.length === 0) return [];
  return [
    `## ${title}`,
    ...entries.map(entry => `- [${entry.name}](${linkResolver?.(entry) ?? entry.relativePath}) — ${entry.description}`),
    "",
  ];
}

function renderProjectMeta(record: ProjectMetaRecord): string {
  return [
    "---",
    `project_id: ${record.projectId}`,
    `project_name: ${record.projectName}`,
    `description: ${record.description}`,
    `status: ${record.status}`,
    `created_at: ${record.createdAt}`,
    `updated_at: ${record.updatedAt}`,
    ...(record.dreamUpdatedAt ? [`dream_updated_at: ${record.dreamUpdatedAt}`] : []),
    "---",
    "",
    "## Summary",
    record.description,
    "",
  ].join("\n");
}

function parseProjectMeta(absolutePath: string): ProjectMetaRecord | undefined {
  if (!existsSync(absolutePath)) return undefined;
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatterBlock(raw);
  const values = new Map<string, string>();
  if (raw.startsWith("---\n")) {
    const endIndex = raw.indexOf("\n---\n", 4);
    if (endIndex !== -1) {
      for (const line of splitLines(raw.slice(4, endIndex))) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
    }
  }
  const projectName = normalizeWhitespace(values.get("project_name"));
  if (!projectName) return undefined;
  const description = normalizeDescription(values.get("description"), projectName);
  return {
    projectId: CURRENT_PROJECT_ID,
    projectName,
    description,
    status: normalizeWhitespace(values.get("status")) || DEFAULT_PROJECT_STATUS,
    createdAt: values.get("created_at") ?? parsed?.frontmatter.updatedAt ?? nowIso(),
    updatedAt: values.get("updated_at") ?? parsed?.frontmatter.updatedAt ?? nowIso(),
    ...(values.get("dream_updated_at") ? { dreamUpdatedAt: values.get("dream_updated_at") } : {}),
    relativePath: PROJECT_META_FILE,
    absolutePath,
  };
}

function normalizeProjectStatus(value: string | undefined): string {
  const normalized = normalizeWhitespace(value);
  return normalized || DEFAULT_PROJECT_STATUS;
}

export {
  mergeCandidates,
  normalizeProjectStatus,
  parseProjectMeta,
  renderManifestSection,
  renderProjectMeta,
  sameOrigin,
  sortEntries,
};
