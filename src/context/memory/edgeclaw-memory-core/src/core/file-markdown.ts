// file-memory 的 markdown 解析/构建（从 file-memory.ts 拆出，逐字搬移）。
// frontmatter 解析渲染 + body 构建 + 候选描述/合并所需 frontmatter。
import { nowIso } from "./utils/id.js";
import { CURRENT_PROJECT_ID, DEFAULT_PROJECT_STATUS } from "./file-constants.js";
import {
  normalizeDescription,
  normalizeWhitespace,
  parseBoolean,
  parseInteger,
  splitLines,
  uniqueStrings,
} from "./file-text.js";
import type { GeneralProjectSourceKind, MemoryCandidate, MemoryFileFrontmatter } from "./types.js";

// 本地类型（与 file-memory.ts 内同名定义逐字一致，非导出）。
type ParsedMarkdownFile = {
  frontmatter: MemoryFileFrontmatter;
  body: string;
};

function parseFrontmatterBlock(raw: string): ParsedMarkdownFile | undefined {
  if (!raw.startsWith("---\n")) return undefined;
  const endIndex = raw.indexOf("\n---\n", 4);
  if (endIndex === -1) return undefined;
  const header = raw.slice(4, endIndex);
  const body = raw.slice(endIndex + 5).replace(/^\n+/, "");
  const values = new Map<string, string>();
  for (const line of splitLines(header)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const type = values.get("type");
  const scope = values.get("scope");
  if (
    (type !== "user" && type !== "project" && type !== "feedback" && type !== "general_project_meta") ||
    (scope !== "global" && scope !== "project")
  ) {
    return undefined;
  }
  return {
    frontmatter: {
      name: values.get("name") ?? "",
      description: values.get("description") ?? "",
      type,
      scope,
      ...(values.get("project_id") ? { projectId: values.get("project_id") } : {}),
      ...(values.get("source_kind") ? { sourceKind: values.get("source_kind") as GeneralProjectSourceKind } : {}),
      ...(values.get("source_workspace_path") ? { sourceWorkspacePath: values.get("source_workspace_path") } : {}),
      ...(values.get("source_project_id") ? { sourceProjectId: values.get("source_project_id") } : {}),
      updatedAt: values.get("updated_at") ?? nowIso(),
      ...(values.get("dream_updated_at") ? { dreamUpdatedAt: values.get("dream_updated_at") } : {}),
      ...(values.get("captured_at") ? { capturedAt: values.get("captured_at") } : {}),
      ...(values.get("source_session_key") ? { sourceSessionKey: values.get("source_session_key") } : {}),
      ...(parseBoolean(values.get("deprecated")) !== undefined
        ? { deprecated: parseBoolean(values.get("deprecated")) }
        : {}),
      ...(parseInteger(values.get("dream_attempts")) !== undefined
        ? { dreamAttempts: parseInteger(values.get("dream_attempts")) }
        : {}),
    },
    body,
  };
}

function renderFrontmatter(frontmatter: MemoryFileFrontmatter): string {
  const lines = [
    "---",
    `name: ${normalizeWhitespace(frontmatter.name)}`,
    `description: ${normalizeDescription(frontmatter.description, frontmatter.name)}`,
    `type: ${frontmatter.type}`,
    `scope: ${frontmatter.scope}`,
    ...(frontmatter.projectId ? [`project_id: ${frontmatter.projectId}`] : []),
    ...(frontmatter.sourceKind ? [`source_kind: ${frontmatter.sourceKind}`] : []),
    ...(frontmatter.sourceWorkspacePath ? [`source_workspace_path: ${frontmatter.sourceWorkspacePath}`] : []),
    ...(frontmatter.sourceProjectId ? [`source_project_id: ${frontmatter.sourceProjectId}`] : []),
    `updated_at: ${frontmatter.updatedAt}`,
    ...(frontmatter.dreamUpdatedAt ? [`dream_updated_at: ${frontmatter.dreamUpdatedAt}`] : []),
    ...(frontmatter.capturedAt ? [`captured_at: ${frontmatter.capturedAt}`] : []),
    ...(frontmatter.sourceSessionKey ? [`source_session_key: ${frontmatter.sourceSessionKey}`] : []),
    ...(typeof frontmatter.deprecated === "boolean"
      ? [`deprecated: ${frontmatter.deprecated ? "true" : "false"}`]
      : []),
    ...(typeof frontmatter.dreamAttempts === "number" ? [`dream_attempts: ${frontmatter.dreamAttempts}`] : []),
    "---",
    "",
  ];
  return `${lines.join("\n")}`;
}

function parseMarkdownSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  let bucket: string[] = [];
  for (const line of splitLines(body.trim())) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.set(current, bucket);
      current = heading[1]!.trim().toLowerCase();
      bucket = [];
      continue;
    }
    if (!current) continue;
    bucket.push(line);
  }
  if (current) sections.set(current, bucket);
  return sections;
}

function parseListSection(lines: string[] | undefined): string[] {
  if (!lines) return [];
  return uniqueStrings(lines.map(line => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean));
}

function parseParagraphSection(lines: string[] | undefined): string {
  if (!lines) return "";
  return normalizeWhitespace(lines.join(" ").trim());
}

function splitFactText(text: string): string[] {
  return uniqueStrings(
    text
      .replace(/\r/g, "\n")
      .split(/\n|[，,；;。.!?]/)
      .map(line => normalizeWhitespace(line))
      .filter(line => line.length >= 2),
  );
}

function parseFactSection(lines: string[] | undefined): string[] {
  if (!lines) return [];
  const facts = lines.flatMap(line => {
    const stripped = line.replace(/^\s*-\s*/, "").trim();
    if (!stripped) return [];
    return /^\s*-\s*/.test(line) ? [stripped] : splitFactText(stripped);
  });
  return uniqueStrings(facts);
}

function buildUserBody(candidate: MemoryCandidate): string {
  const identityBackground = uniqueStrings([
    ...splitFactText(candidate.profile || candidate.summary || candidate.description || ""),
    ...(candidate.relationships ?? []).map(item => normalizeWhitespace(item)),
  ]);
  const lines: string[] = [];
  if (identityBackground.length > 0) {
    lines.push("## 身份背景", ...identityBackground.map(item => `- ${item}`), "");
  }
  if (lines.length === 0) {
    lines.push("## 身份背景", "- 暂无稳定用户画像信息。", "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildProjectBody(candidate: MemoryCandidate): string {
  const lines: string[] = [];
  if (normalizeWhitespace(candidate.stage)) {
    lines.push("## Current Stage", normalizeWhitespace(candidate.stage), "");
  }
  const sections: Array<[string, string[] | undefined]> = [
    ["Decisions", candidate.decisions],
    ["Constraints", candidate.constraints],
    ["Next Steps", candidate.nextSteps],
    ["Blockers", candidate.blockers],
    ["Timeline", candidate.timeline],
    ["Notes", candidate.notes],
  ];
  for (const [title, values] of sections) {
    const normalized = uniqueStrings(values ?? []);
    if (normalized.length === 0) continue;
    lines.push(`## ${title}`, ...normalized.map(item => `- ${item}`), "");
  }
  if (normalizeWhitespace(candidate.summary)) {
    lines.push("## Summary", normalizeWhitespace(candidate.summary), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildFeedbackBody(candidate: MemoryCandidate): string {
  const lines = [
    "## Rule",
    normalizeWhitespace(candidate.rule || candidate.description || candidate.summary || candidate.name),
    "",
  ];
  if (normalizeWhitespace(candidate.why)) lines.push("## Why", normalizeWhitespace(candidate.why), "");
  if (normalizeWhitespace(candidate.howToApply)) {
    lines.push("## How To Apply", normalizeWhitespace(candidate.howToApply), "");
  }
  const notes = uniqueStrings(candidate.notes ?? []);
  if (notes.length > 0) lines.push("## Notes", ...notes.map(item => `- ${item}`), "");
  return `${lines.join("\n").trim()}\n`;
}

function buildGeneralProjectMetaBody(input: {
  projectName: string;
  description: string;
  status: string;
  sourceKind?: GeneralProjectSourceKind;
  sourceWorkspacePath?: string;
  sourceProjectId?: string;
}): string {
  const lines = [
    "## Summary",
    normalizeDescription(input.description, input.projectName),
    "",
    "## Status",
    normalizeWhitespace(input.status) || DEFAULT_PROJECT_STATUS,
    "",
  ];
  const sourceNotes = uniqueStrings([
    input.sourceKind === "workspace_external_mirror"
      ? "This project mirrors a read-only external workspace project."
      : "",
    input.sourceWorkspacePath ? `Source workspace: ${input.sourceWorkspacePath}` : "",
    input.sourceProjectId ? `Source project id: ${input.sourceProjectId}` : "",
  ]);
  if (sourceNotes.length > 0) {
    lines.push("## Source", ...sourceNotes.map(item => `- ${item}`), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildRecordBody(candidate: MemoryCandidate): string {
  if (normalizeWhitespace(candidate.body)) {
    return `${candidate.body!.trim()}\n`;
  }
  if (candidate.type === "general_project_meta") {
    return buildGeneralProjectMetaBody({
      projectName: candidate.name,
      description: candidate.description,
      status: candidate.stage || DEFAULT_PROJECT_STATUS,
      ...((candidate as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind
        ? { sourceKind: (candidate as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind }
        : {}),
      ...((candidate as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath
        ? { sourceWorkspacePath: (candidate as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath }
        : {}),
      ...((candidate as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId
        ? { sourceProjectId: (candidate as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId }
        : {}),
    });
  }
  if (candidate.type === "user") return buildUserBody(candidate);
  if (candidate.type === "feedback") return buildFeedbackBody(candidate);
  return buildProjectBody(candidate);
}

function candidateDescription(candidate: MemoryCandidate): string {
  if (candidate.type === "user") {
    return normalizeDescription(candidate.description, candidate.profile || candidate.summary || candidate.name);
  }
  if (candidate.type === "feedback") {
    return normalizeDescription(candidate.description, candidate.rule || candidate.summary || candidate.name);
  }
  return normalizeDescription(
    candidate.description,
    candidate.summary ||
      candidate.stage ||
      uniqueStrings(candidate.blockers ?? [])[0] ||
      uniqueStrings(candidate.decisions ?? [])[0] ||
      candidate.name,
  );
}

function buildFrontmatter(
  candidate: MemoryCandidate,
  existing?: Partial<MemoryFileFrontmatter>,
): MemoryFileFrontmatter {
  const scope = candidate.type === "user" ? "global" : candidate.scope || "project";
  return {
    name: normalizeWhitespace(candidate.name) || normalizeWhitespace(existing?.name) || "memory-item",
    description: candidateDescription(candidate) || normalizeWhitespace(existing?.description) || "memory-item",
    type: candidate.type,
    scope,
    ...(scope === "project"
      ? {
          projectId:
            normalizeWhitespace(candidate.projectId) || normalizeWhitespace(existing?.projectId) || CURRENT_PROJECT_ID,
        }
      : {}),
    ...(candidate.type === "general_project_meta" &&
    (candidate as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind
      ? { sourceKind: (candidate as MemoryCandidate & { sourceKind?: GeneralProjectSourceKind }).sourceKind }
      : existing?.sourceKind
        ? { sourceKind: existing.sourceKind }
        : {}),
    ...(candidate.type === "general_project_meta" &&
    (candidate as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath
      ? { sourceWorkspacePath: (candidate as MemoryCandidate & { sourceWorkspacePath?: string }).sourceWorkspacePath }
      : existing?.sourceWorkspacePath
        ? { sourceWorkspacePath: existing.sourceWorkspacePath }
        : {}),
    ...(candidate.type === "general_project_meta" &&
    (candidate as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId
      ? { sourceProjectId: (candidate as MemoryCandidate & { sourceProjectId?: string }).sourceProjectId }
      : existing?.sourceProjectId
        ? { sourceProjectId: existing.sourceProjectId }
        : {}),
    updatedAt: nowIso(),
    ...(existing?.dreamUpdatedAt ? { dreamUpdatedAt: existing.dreamUpdatedAt } : {}),
    ...(candidate.capturedAt || existing?.capturedAt
      ? { capturedAt: candidate.capturedAt || existing?.capturedAt }
      : {}),
    ...(candidate.sourceSessionKey || existing?.sourceSessionKey
      ? { sourceSessionKey: candidate.sourceSessionKey || existing?.sourceSessionKey }
      : {}),
    ...(typeof existing?.deprecated === "boolean" ? { deprecated: existing.deprecated } : {}),
    ...(typeof existing?.dreamAttempts === "number" ? { dreamAttempts: existing.dreamAttempts } : {}),
  };
}

export {
  buildFeedbackBody,
  buildFrontmatter,
  buildGeneralProjectMetaBody,
  buildProjectBody,
  buildRecordBody,
  buildUserBody,
  candidateDescription,
  parseFactSection,
  parseFrontmatterBlock,
  parseListSection,
  parseMarkdownSections,
  parseParagraphSection,
  renderFrontmatter,
  splitFactText,
};
