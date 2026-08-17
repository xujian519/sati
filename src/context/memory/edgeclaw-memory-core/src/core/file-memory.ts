import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type {
  GeneralProjectSourceKind,
  MemoryCandidate,
  MemoryEntryEditFields,
  MemoryFileExportRecord,
  MemoryFileFrontmatter,
  MemoryFileRecord,
  MemoryManifestEntry,
  MemorySnapshotFileRecord,
  MemoryUserSummary,
  ProjectIdentityHint,
  ProjectMetaExportRecord,
  ProjectMetaRecord,
  WorkspaceMemoryMode,
} from "./types.js";
import { GENERAL_PROJECT_META_DIR } from "./general-projects.js";
import { hashText, nowIso } from "./utils/id.js";
import {
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_STATUS,
  DEFAULT_USER_PROFILE_RELATIVE_PATH,
  FEEDBACK_DIR,
  MANIFEST_FILE,
  PROJECT_DIR,
  PROJECT_META_FILE,
  USER_NOTES_DIR,
  CURRENT_PROJECT_ID,
} from "./file-constants.js";
import {
  ensureDir,
  normalizeDescription,
  normalizeWhitespace,
  previewContent,
  slugify,
  trimContentLines,
  uniqueStrings,
} from "./file-text.js";
import {
  buildFrontmatter,
  buildGeneralProjectMetaBody,
  buildRecordBody,
  candidateDescription,
  parseFactSection,
  parseFrontmatterBlock,
  parseListSection,
  parseMarkdownSections,
  parseParagraphSection,
  renderFrontmatter,
} from "./file-markdown.js";
import {
  mergeCandidates,
  normalizeProjectStatus,
  parseProjectMeta,
  renderManifestSection,
  renderProjectMeta,
  sameOrigin,
  sortEntries,
} from "./file-manifest.js";
// 公共 API 面（core/index.ts 经 export * 直出）：常量定义已下沉 file-constants.ts。
export { TMP_PROJECT_ID, CURRENT_PROJECT_ID } from "./file-constants.js";

export interface FileMemoryStoreOptions {
  workspaceMode?: WorkspaceMemoryMode;
  manageProjectMeta?: boolean;
  manageProjectFiles?: boolean;
  manageUserProfile?: boolean;
  userProfileRelativePath?: string | null;
  userNotesRelativeDir?: string | null;
  appendOnlyUserEntries?: boolean;
  enableManifest?: boolean;
  manifestUserEntriesProvider?: () => MemoryManifestEntry[];
}

export interface FileMemoryOverview {
  totalFiles: number;
  projectMemories: number;
  feedbackMemories: number;
  userProfiles: number;
  changedFilesSinceLastDream: number;
  tmpTotalFiles: number;
  tmpFeedbackMemories: number;
  tmpProjectMemories: number;
  projectMetaCount: number;
  generalProjectMetaCount?: number;
  latestMemoryAt?: string;
}

type ParsedMarkdownFile = {
  frontmatter: MemoryFileFrontmatter;
  body: string;
};

type FileRecordWrite = {
  relativePath: string;
  frontmatter: MemoryFileFrontmatter;
  body: string;
};

export class FileMemoryStore {
  private readonly workspaceMode: WorkspaceMemoryMode;
  private readonly manageProjectMeta: boolean;
  private readonly manageProjectFiles: boolean;
  private readonly manageUserProfile: boolean;
  private readonly userProfileRelativePath: string | null;
  private readonly userNotesRelativeDir: string | null;
  private readonly appendOnlyUserEntries: boolean;
  private readonly enableManifest: boolean;
  private readonly manifestUserEntriesProvider?: () => MemoryManifestEntry[];

  constructor(
    private readonly rootDir: string,
    options: FileMemoryStoreOptions = {},
  ) {
    this.workspaceMode = options.workspaceMode ?? "single";
    this.manageProjectMeta = options.manageProjectMeta ?? true;
    this.manageProjectFiles = options.manageProjectFiles ?? true;
    this.manageUserProfile = options.manageUserProfile ?? true;
    this.userProfileRelativePath = this.manageUserProfile
      ? options.userProfileRelativePath === undefined
        ? DEFAULT_USER_PROFILE_RELATIVE_PATH
        : options.userProfileRelativePath
      : null;
    this.userNotesRelativeDir = this.manageUserProfile
      ? options.userNotesRelativeDir === undefined
        ? null
        : options.userNotesRelativeDir
      : null;
    this.appendOnlyUserEntries = this.manageUserProfile ? Boolean(options.appendOnlyUserEntries) : false;
    this.enableManifest = options.enableManifest ?? true;
    this.manifestUserEntriesProvider = options.manifestUserEntriesProvider;
    this.ensureLayout();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getWorkspaceMode(): WorkspaceMemoryMode {
    return this.workspaceMode;
  }

  isGeneralMode(): boolean {
    return this.workspaceMode === "general";
  }

  getUserProfileRelativePath(): string | null {
    return this.userProfileRelativePath;
  }

  private projectMetaPath(): string {
    return this.resolveRelativePath(PROJECT_META_FILE);
  }

  private requireUserProfileRelativePath(): string {
    if (!this.manageUserProfile || !this.userProfileRelativePath) {
      throw new Error("Global user profile storage is disabled for this store");
    }
    return this.userProfileRelativePath;
  }

  private ensureLayout(): void {
    ensureDir(this.rootDir);
    if (this.manageUserProfile && this.userProfileRelativePath) {
      ensureDir(dirname(this.resolveRelativePath(this.userProfileRelativePath)));
    }
    if (this.manageUserProfile && this.userNotesRelativeDir) {
      ensureDir(this.resolveRelativePath(this.userNotesRelativeDir));
    }
    if (this.manageProjectFiles) {
      ensureDir(join(this.rootDir, PROJECT_DIR));
      ensureDir(join(this.rootDir, FEEDBACK_DIR));
    }
    if (this.manageProjectMeta && this.isGeneralMode()) {
      ensureDir(join(this.rootDir, GENERAL_PROJECT_META_DIR));
    }
  }

  private resolveRelativePath(relativePath: string): string {
    return resolve(this.rootDir, relativePath);
  }

  private isPathWithinRoot(relativePath: string): boolean {
    const absolutePath = this.resolveRelativePath(relativePath);
    const rel = relative(this.rootDir, absolutePath);
    return rel === relativePath || (!rel.startsWith("..") && !rel.includes(".."));
  }

  private readMarkdownFile(relativePath: string): ParsedMarkdownFile | undefined {
    if (!this.isPathWithinRoot(relativePath)) return undefined;
    const absolutePath = this.resolveRelativePath(relativePath);
    if (!existsSync(absolutePath)) return undefined;
    return parseFrontmatterBlock(readFileSync(absolutePath, "utf8"));
  }

  private buildManifestEntry(relativePath: string): MemoryManifestEntry | undefined {
    const parsed = this.readMarkdownFile(relativePath);
    if (!parsed) return undefined;
    return {
      ...parsed.frontmatter,
      ...(parsed.frontmatter.scope === "project"
        ? {
            projectId: normalizeWhitespace(parsed.frontmatter.projectId) || CURRENT_PROJECT_ID,
          }
        : {}),
      file: relativePath.split("/").pop() ?? relativePath,
      relativePath,
      absolutePath: this.resolveRelativePath(relativePath),
    };
  }

  private writeRecord(input: FileRecordWrite): MemoryFileRecord {
    const absolutePath = this.resolveRelativePath(input.relativePath);
    ensureDir(dirname(absolutePath));
    const rendered = `${renderFrontmatter(input.frontmatter)}${input.body.trim()}\n`;
    writeFileSync(absolutePath, rendered, "utf8");
    this.repairManifests();
    return this.getMemoryRecordsByIds([input.relativePath], 5000)[0]!;
  }

  private collectDirectoryRecords(relativeDir: string): MemoryManifestEntry[] {
    const directory = join(this.rootDir, relativeDir);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
      .filter(entry => entry.name !== MANIFEST_FILE && entry.name !== PROJECT_META_FILE)
      .map(entry => this.buildManifestEntry(join(relativeDir, entry.name)))
      .filter((entry): entry is MemoryManifestEntry => Boolean(entry));
  }

  private collectAllEntries(): MemoryManifestEntry[] {
    const entries: MemoryManifestEntry[] = [];
    if (this.manageProjectMeta && this.isGeneralMode()) {
      entries.push(...this.collectDirectoryRecords(GENERAL_PROJECT_META_DIR));
    }
    if (this.manageProjectFiles) {
      entries.push(...this.collectDirectoryRecords(PROJECT_DIR));
      entries.push(...this.collectDirectoryRecords(FEEDBACK_DIR));
    }
    if (this.manageUserProfile && this.userProfileRelativePath) {
      const userEntry = this.buildManifestEntry(this.userProfileRelativePath);
      if (userEntry) entries.push(userEntry);
    }
    if (this.manageUserProfile && this.userNotesRelativeDir) {
      entries.push(...this.collectDirectoryRecords(this.userNotesRelativeDir));
    }
    return sortEntries(entries);
  }

  private readProjectMetaFile(): ProjectMetaRecord | undefined {
    if (!this.manageProjectMeta || this.isGeneralMode()) return undefined;
    return parseProjectMeta(this.projectMetaPath());
  }

  private buildProjectMetaSeed(): {
    projectName: string;
    description: string;
    status: string;
  } {
    const entries = this.collectAllEntries().filter(entry => entry.scope === "project" && !entry.deprecated);
    const firstProject = entries.find(entry => entry.type === "project");
    const firstFeedback = entries.find(entry => entry.type === "feedback");
    const first = firstProject ?? firstFeedback;
    if (!first) {
      return {
        projectName: DEFAULT_PROJECT_NAME,
        description: "Current project memory.",
        status: DEFAULT_PROJECT_STATUS,
      };
    }
    return {
      projectName: firstProject?.name || DEFAULT_PROJECT_NAME,
      description: firstProject?.description || first.description || DEFAULT_PROJECT_NAME,
      status: DEFAULT_PROJECT_STATUS,
    };
  }

  private generalProjectMetaRelativePath(projectId: string, projectName: string): string {
    const normalizedProjectId = normalizeWhitespace(projectId) || hashText(`${projectName}:${nowIso()}`).slice(0, 12);
    return join(
      GENERAL_PROJECT_META_DIR,
      `${slugify(projectName || normalizedProjectId)}-${normalizedProjectId.slice(0, 12)}.md`,
    );
  }

  private toGeneralProjectMetaRecord(record: MemoryFileRecord): ProjectMetaRecord | undefined {
    if (record.type !== "general_project_meta") return undefined;
    return {
      projectId: normalizeWhitespace(record.projectId) || CURRENT_PROJECT_ID,
      projectName: record.name,
      description: normalizeDescription(record.description, record.name),
      status: parseParagraphSection(parseMarkdownSections(record.content).get("status")) || DEFAULT_PROJECT_STATUS,
      ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
      ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
      ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
      createdAt: record.capturedAt || record.updatedAt,
      updatedAt: record.updatedAt,
      ...(record.dreamUpdatedAt ? { dreamUpdatedAt: record.dreamUpdatedAt } : {}),
      relativePath: record.relativePath,
      absolutePath: record.absolutePath,
    };
  }

  private listGeneralProjectMetaEntries(includeDeprecated = false): MemoryManifestEntry[] {
    return this.collectAllEntries()
      .filter(entry => entry.type === "general_project_meta")
      .filter(entry => includeDeprecated || !entry.deprecated);
  }

  upsertGeneralProjectMeta(input: {
    projectId?: string;
    projectName: string;
    description?: string;
    status?: string;
    sourceKind?: GeneralProjectSourceKind;
    sourceWorkspacePath?: string;
    sourceProjectId?: string;
    dreamUpdatedAt?: string;
  }): ProjectMetaRecord {
    if (!this.manageProjectMeta || !this.isGeneralMode()) {
      throw new Error("General project metadata is disabled for this store");
    }
    const normalizedProjectId =
      normalizeWhitespace(input.projectId) ||
      hashText(
        `${normalizeWhitespace(input.projectName)}:${normalizeWhitespace(input.sourceWorkspacePath)}:${normalizeWhitespace(input.sourceProjectId)}:${nowIso()}`,
      ).slice(0, 16);
    const existing = this.listProjectMetas().find(meta => meta.projectId === normalizedProjectId);
    const relativePath =
      existing?.relativePath ?? this.generalProjectMetaRelativePath(normalizedProjectId, input.projectName);
    const frontmatter: MemoryFileFrontmatter = {
      name: normalizeWhitespace(input.projectName) || existing?.projectName || DEFAULT_PROJECT_NAME,
      description: normalizeDescription(input.description, existing?.description || input.projectName),
      type: "general_project_meta",
      scope: "project",
      projectId: normalizedProjectId,
      ...(input.sourceKind || existing?.sourceKind ? { sourceKind: input.sourceKind || existing?.sourceKind } : {}),
      ...(input.sourceWorkspacePath || existing?.sourceWorkspacePath
        ? { sourceWorkspacePath: input.sourceWorkspacePath || existing?.sourceWorkspacePath }
        : {}),
      ...(input.sourceProjectId || existing?.sourceProjectId
        ? { sourceProjectId: input.sourceProjectId || existing?.sourceProjectId }
        : {}),
      updatedAt: nowIso(),
      ...(existing?.createdAt ? { capturedAt: existing.createdAt } : {}),
      ...(normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt)
        ? { dreamUpdatedAt: normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt) }
        : {}),
    };
    const record = this.writeRecord({
      relativePath,
      frontmatter,
      body: buildGeneralProjectMetaBody({
        projectName: frontmatter.name,
        description: frontmatter.description,
        status: normalizeProjectStatus(input.status || existing?.status || DEFAULT_PROJECT_STATUS),
        ...(frontmatter.sourceKind ? { sourceKind: frontmatter.sourceKind } : {}),
        ...(frontmatter.sourceWorkspacePath ? { sourceWorkspacePath: frontmatter.sourceWorkspacePath } : {}),
        ...(frontmatter.sourceProjectId ? { sourceProjectId: frontmatter.sourceProjectId } : {}),
      }),
    });
    return this.toGeneralProjectMetaRecord(record)!;
  }

  upsertProjectMeta(
    input: {
      projectId?: string;
      projectName?: string;
      description?: string;
      status?: string;
      sourceKind?: GeneralProjectSourceKind;
      sourceWorkspacePath?: string;
      sourceProjectId?: string;
      dreamUpdatedAt?: string;
    } = {},
  ): ProjectMetaRecord {
    if (!this.manageProjectMeta) {
      throw new Error("Project metadata is disabled for this store");
    }
    if (this.isGeneralMode()) {
      return this.upsertGeneralProjectMeta({
        projectId: input.projectId,
        projectName: normalizeWhitespace(input.projectName) || DEFAULT_PROJECT_NAME,
        description: input.description,
        status: input.status,
        ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
        ...(input.sourceWorkspacePath ? { sourceWorkspacePath: input.sourceWorkspacePath } : {}),
        ...(input.sourceProjectId ? { sourceProjectId: input.sourceProjectId } : {}),
        ...(input.dreamUpdatedAt ? { dreamUpdatedAt: input.dreamUpdatedAt } : {}),
      });
    }
    const existing = this.readProjectMetaFile();
    const seed = this.buildProjectMetaSeed();
    const projectName = normalizeWhitespace(input.projectName) || existing?.projectName || seed.projectName;
    const description = normalizeDescription(
      input.description,
      existing?.description || seed.description || projectName,
    );
    const next: ProjectMetaRecord = {
      projectId: CURRENT_PROJECT_ID,
      projectName,
      description,
      status: normalizeProjectStatus(input.status || existing?.status || seed.status),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      ...(normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt)
        ? { dreamUpdatedAt: normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt) }
        : {}),
      relativePath: PROJECT_META_FILE,
      absolutePath: this.projectMetaPath(),
    };
    writeFileSync(next.absolutePath, `${renderProjectMeta(next).trim()}\n`, "utf8");
    this.repairManifests();
    return next;
  }

  ensureProjectMeta(
    input: {
      projectId?: string;
      projectName?: string;
      description?: string;
      status?: string;
      sourceKind?: GeneralProjectSourceKind;
      sourceWorkspacePath?: string;
      sourceProjectId?: string;
    } = {},
  ): ProjectMetaRecord {
    if (this.isGeneralMode()) {
      const normalizedProjectId = normalizeWhitespace(input.projectId);
      const existing = normalizedProjectId ? this.getProjectMeta(normalizedProjectId) : undefined;
      return existing ?? this.upsertProjectMeta(input);
    }
    return this.readProjectMetaFile() ?? this.upsertProjectMeta(input);
  }

  private findExistingRecordForCandidate(candidate: MemoryCandidate): MemoryManifestEntry | undefined {
    const allEntries = this.collectAllEntries();
    const sameSource = allEntries.find(entry => sameOrigin(entry, candidate));
    if (sameSource) return sameSource;
    if (candidate.type === "user") {
      if (this.appendOnlyUserEntries) return undefined;
      return this.manageUserProfile && this.userProfileRelativePath
        ? allEntries.find(entry => entry.relativePath === this.userProfileRelativePath)
        : undefined;
    }
    return undefined;
  }

  private nextRecordRelativePath(candidate: MemoryCandidate): string {
    if (candidate.type === "user") {
      if (!this.appendOnlyUserEntries) return this.requireUserProfileRelativePath();
      const directory = this.userNotesRelativeDir ?? USER_NOTES_DIR;
      const seed = `${candidate.type}:${candidate.name}:${candidate.description}:${candidate.capturedAt ?? ""}:${candidate.sourceSessionKey ?? nowIso()}`;
      return join(directory, `${slugify(candidate.name)}-${hashText(seed).slice(0, 10)}.md`);
    }
    const directory = candidate.type === "feedback" ? FEEDBACK_DIR : PROJECT_DIR;
    const seed = `${candidate.type}:${candidate.projectId ?? ""}:${candidate.name}:${candidate.description}:${candidate.capturedAt ?? ""}:${candidate.sourceSessionKey ?? nowIso()}`;
    return join(directory, `${slugify(candidate.name)}-${hashText(seed).slice(0, 10)}.md`);
  }

  private resolveManifestLinkPath(entry: MemoryManifestEntry): string {
    const rel = relative(this.rootDir, entry.absolutePath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return rel || entry.relativePath;
    return entry.relativePath;
  }

  private buildManifest(): string {
    const projectMeta = this.readProjectMetaFile();
    const generalProjectMetas = this.isGeneralMode() ? this.listProjectMetas() : [];
    const allEntries = this.collectAllEntries();
    const active = allEntries.filter(entry => !entry.deprecated);
    const deprecated = allEntries.filter(entry => entry.deprecated);
    const projectEntries = active.filter(entry => entry.type === "project");
    const feedbackEntries = active.filter(entry => entry.type === "feedback");
    const userEntries = this.manageUserProfile
      ? active.filter(entry => entry.type === "user")
      : sortEntries((this.manifestUserEntriesProvider?.() ?? []).filter(entry => !entry.deprecated));
    const lines = [
      "# EdgeClaw Memory",
      "",
      `Updated: ${nowIso()}`,
      "",
      ...(projectMeta
        ? [
            "## Current Project Meta",
            `- [${projectMeta.projectName}](${PROJECT_META_FILE}) — ${projectMeta.description}`,
            "",
          ]
        : []),
      ...(generalProjectMetas.length > 0
        ? [
            "## General Projects",
            ...generalProjectMetas.map(meta => `- [${meta.projectName}](${meta.relativePath}) — ${meta.description}`),
            "",
          ]
        : []),
      ...renderManifestSection("Project Memory", projectEntries),
      ...renderManifestSection("Feedback Memory", feedbackEntries),
      ...renderManifestSection("User Memory", userEntries, entry => this.resolveManifestLinkPath(entry)),
      ...renderManifestSection("Deprecated", deprecated),
    ];
    return `${lines.join("\n").trim()}\n`;
  }

  repairManifests(): { changed: number; summary: string; memoryFileCount: number } {
    this.ensureLayout();
    if (!this.enableManifest) {
      return {
        changed: 0,
        summary: "Manifest management is disabled for this store.",
        memoryFileCount: this.collectAllEntries().length,
      };
    }
    const manifestPath = this.resolveRelativePath(MANIFEST_FILE);
    const nextContent = this.buildManifest();
    const previousContent = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
    if (previousContent !== nextContent) {
      writeFileSync(manifestPath, nextContent, "utf8");
      return {
        changed: 1,
        summary: "Rebuilt workspace memory manifest.",
        memoryFileCount: this.collectAllEntries().length,
      };
    }
    return {
      changed: 0,
      summary: "Workspace memory manifest already up to date.",
      memoryFileCount: this.collectAllEntries().length,
    };
  }

  listMemoryEntries(
    options: {
      kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
      query?: string;
      limit?: number;
      offset?: number;
      scope?: "global" | "project";
      projectId?: string;
      includeTmp?: boolean;
      includeDeprecated?: boolean;
    } = {},
  ): MemoryManifestEntry[] {
    const normalizedProjectId = normalizeWhitespace(options.projectId);
    if (normalizedProjectId && !this.isGeneralMode() && normalizedProjectId !== CURRENT_PROJECT_ID) return [];
    const kinds = new Set(options.kinds ?? ["user", "feedback", "project"]);
    const normalizedQuery = normalizeWhitespace(options.query).toLowerCase();
    const filtered = this.collectAllEntries()
      .filter(entry => kinds.has(entry.type))
      .filter(entry => !options.scope || entry.scope === options.scope)
      .filter(entry => {
        if (!normalizedProjectId) return true;
        if (entry.type === "general_project_meta") return entry.projectId === normalizedProjectId;
        if (entry.scope !== "project") return true;
        return (entry.projectId || CURRENT_PROJECT_ID) === normalizedProjectId;
      })
      .filter(entry => options.includeDeprecated || !entry.deprecated)
      .filter(entry => {
        if (!normalizedQuery) return true;
        const haystack = [entry.name, entry.description, entry.relativePath].join(" ").toLowerCase();
        return haystack.includes(normalizedQuery);
      });
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? (filtered.length || 1));
    return filtered.slice(offset, offset + limit);
  }

  countMemoryEntries(
    options: {
      kinds?: Array<"user" | "feedback" | "project" | "general_project_meta">;
      query?: string;
      scope?: "global" | "project";
      projectId?: string;
      includeTmp?: boolean;
      includeDeprecated?: boolean;
    } = {},
  ): number {
    return this.listMemoryEntries(options).length;
  }

  getMemoryRecordsByIds(ids: string[], maxLines = 80): MemoryFileRecord[] {
    return ids
      .map(id => {
        const entry = this.buildManifestEntry(id);
        const parsed = entry ? this.readMarkdownFile(entry.relativePath) : undefined;
        if (!entry || !parsed) return undefined;
        const content = trimContentLines(parsed.body.trim(), maxLines);
        return {
          ...entry,
          content,
          preview: previewContent(parsed.body),
        };
      })
      .filter((record): record is MemoryFileRecord => Boolean(record));
  }

  getUserSummary(): MemoryUserSummary {
    if (!this.manageUserProfile || !this.userProfileRelativePath) {
      return {
        identityBackground: [],
        files: [],
      };
    }
    const record = this.getMemoryRecordsByIds([this.userProfileRelativePath], 5000)[0];
    if (!record) {
      return {
        identityBackground: [],
        files: [],
      };
    }
    const sections = parseMarkdownSections(record.content);
    return {
      identityBackground: uniqueStrings(parseFactSection(sections.get("身份背景"))),
      files: [record],
    };
  }

  upsertUserProfile(candidate: MemoryCandidate): MemoryFileRecord {
    const relativePath = this.requireUserProfileRelativePath();
    const existing = this.buildManifestEntry(relativePath);
    const frontmatter = buildFrontmatter(
      {
        ...candidate,
        type: "user",
        scope: "global",
        name: normalizeWhitespace(candidate.name) || "user-profile",
        description: normalizeDescription(candidate.description, candidate.name || "User profile"),
      },
      existing,
    );
    return this.writeRecord({
      relativePath,
      frontmatter,
      body: buildRecordBody(candidate),
    });
  }

  upsertCandidate(candidate: MemoryCandidate): MemoryFileRecord {
    let resolvedCandidate = candidate;
    if (candidate.type !== "user" && this.manageProjectMeta) {
      if (this.isGeneralMode()) {
        const projectId =
          normalizeWhitespace(candidate.projectId) ||
          this.ensureProjectMeta({
            projectName: candidate.type === "project" ? candidate.name : candidate.description || candidate.name,
            description: candidate.description,
          }).projectId;
        resolvedCandidate = {
          ...candidate,
          projectId,
        };
      } else {
        this.ensureProjectMeta({
          ...(candidate.type === "project" ? { projectName: candidate.name } : {}),
          description: candidate.description,
        });
      }
    }
    const existing = this.findExistingRecordForCandidate(resolvedCandidate);
    const frontmatter = buildFrontmatter(resolvedCandidate, existing);
    const relativePath = existing?.relativePath ?? this.nextRecordRelativePath(resolvedCandidate);
    const record = this.writeRecord({
      relativePath,
      frontmatter,
      body: buildRecordBody(resolvedCandidate),
    });
    if (resolvedCandidate.type === "project" && !this.isGeneralMode()) {
      const projectMeta = this.readProjectMetaFile();
      if (projectMeta) {
        const autoSeedLike =
          normalizeWhitespace(projectMeta.projectName).toLowerCase() === DEFAULT_PROJECT_NAME.toLowerCase() ||
          /workspace memory$/i.test(projectMeta.description) ||
          normalizeWhitespace(projectMeta.description).toLowerCase() === "current project memory.";
        this.upsertProjectMeta({
          ...(autoSeedLike ? { projectName: resolvedCandidate.name } : {}),
          ...(autoSeedLike && resolvedCandidate.description ? { description: resolvedCandidate.description } : {}),
          status: projectMeta.status,
        });
      }
    }
    return record;
  }

  toCandidate(record: MemoryFileRecord): MemoryCandidate {
    const sections = parseMarkdownSections(record.content);
    if (record.type === "general_project_meta") {
      return {
        type: "general_project_meta",
        scope: "project",
        projectId: record.projectId,
        name: record.name,
        description: record.description,
        body: record.content,
        ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
        ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
        ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
        ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
        stage: parseParagraphSection(sections.get("status")),
      };
    }
    if (record.type === "user") {
      const identityFacts = parseFactSection(sections.get("身份背景"));
      return {
        type: "user",
        scope: "global",
        name: record.name,
        description: record.description,
        body: record.content,
        ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
        ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
        profile: identityFacts.join("；") || normalizeWhitespace(record.content),
        relationships: identityFacts,
      };
    }
    if (record.type === "feedback") {
      return {
        type: "feedback",
        scope: "project",
        ...(record.projectId ? { projectId: record.projectId } : {}),
        name: record.name,
        description: record.description,
        body: record.content,
        ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
        ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
        rule: parseParagraphSection(sections.get("rule")),
        why: parseParagraphSection(sections.get("why")),
        howToApply: parseParagraphSection(sections.get("how to apply")),
        notes: parseListSection(sections.get("notes")),
      };
    }
    return {
      type: "project",
      scope: "project",
      ...(record.projectId ? { projectId: record.projectId } : {}),
      name: record.name,
      description: record.description,
      body: record.content,
      ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
      ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
      stage: parseParagraphSection(sections.get("current stage")),
      decisions: parseListSection(sections.get("decisions")),
      constraints: parseListSection(sections.get("constraints")),
      nextSteps: parseListSection(sections.get("next steps")),
      blockers: parseListSection(sections.get("blockers")),
      timeline: parseListSection(sections.get("timeline")),
      notes: parseListSection(sections.get("notes")),
      summary: parseParagraphSection(sections.get("summary")),
    };
  }

  editEntry(input: {
    relativePath: string;
    name: string;
    description: string;
    fields?: MemoryEntryEditFields;
  }): MemoryFileRecord {
    const existing = this.getMemoryRecordsByIds([input.relativePath], 5000)[0];
    if (!existing) throw new Error(`Memory entry not found: ${input.relativePath}`);
    const candidate = this.toCandidate(existing);
    const next: MemoryCandidate = {
      ...candidate,
      name: normalizeWhitespace(input.name) || candidate.name,
      description: normalizeDescription(input.description, candidate.description),
    };
    if (input.fields) {
      delete next.body;
      if (typeof input.fields.stage === "string") next.stage = normalizeWhitespace(input.fields.stage);
      if (input.fields.decisions) next.decisions = uniqueStrings(input.fields.decisions);
      if (input.fields.constraints) next.constraints = uniqueStrings(input.fields.constraints);
      if (input.fields.nextSteps) next.nextSteps = uniqueStrings(input.fields.nextSteps);
      if (input.fields.blockers) next.blockers = uniqueStrings(input.fields.blockers);
      if (input.fields.timeline) next.timeline = uniqueStrings(input.fields.timeline);
      if (input.fields.notes) next.notes = uniqueStrings(input.fields.notes);
      if (typeof input.fields.rule === "string") next.rule = normalizeWhitespace(input.fields.rule);
      if (typeof input.fields.why === "string") next.why = normalizeWhitespace(input.fields.why);
      if (typeof input.fields.howToApply === "string") next.howToApply = normalizeWhitespace(input.fields.howToApply);
    }
    return this.writeRecord({
      relativePath: input.relativePath,
      frontmatter: {
        ...existing,
        ...(existing.scope === "project" && existing.projectId ? { projectId: existing.projectId } : {}),
        name: next.name,
        description: candidateDescription(next),
        updatedAt: nowIso(),
      },
      body: buildRecordBody(next),
    });
  }

  markEntriesDeprecated(relativePaths: string[]): { mutatedIds: string[]; deletedProjectIds: string[] } {
    const mutatedIds: string[] = [];
    for (const relativePath of relativePaths) {
      const record = this.getMemoryRecordsByIds([relativePath], 5000)[0];
      if (!record) continue;
      this.writeRecord({
        relativePath,
        frontmatter: {
          ...record,
          ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
          updatedAt: nowIso(),
          deprecated: true,
        },
        body: record.content,
      });
      mutatedIds.push(relativePath);
    }
    return { mutatedIds, deletedProjectIds: [] };
  }

  restoreEntries(relativePaths: string[]): { mutatedIds: string[]; deletedProjectIds: string[] } {
    const mutatedIds: string[] = [];
    for (const relativePath of relativePaths) {
      const record = this.getMemoryRecordsByIds([relativePath], 5000)[0];
      if (!record) continue;
      this.writeRecord({
        relativePath,
        frontmatter: {
          ...record,
          ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
          updatedAt: nowIso(),
          deprecated: false,
        },
        body: record.content,
      });
      mutatedIds.push(relativePath);
    }
    return { mutatedIds, deletedProjectIds: [] };
  }

  deleteEntries(relativePaths: string[]): { mutatedIds: string[]; deletedProjectIds: string[] } {
    const mutatedIds: string[] = [];
    for (const relativePath of relativePaths) {
      if (!this.isPathWithinRoot(relativePath)) continue;
      const absolutePath = this.resolveRelativePath(relativePath);
      if (!existsSync(absolutePath)) continue;
      unlinkSync(absolutePath);
      mutatedIds.push(relativePath);
    }
    this.repairManifests();
    return { mutatedIds, deletedProjectIds: [] };
  }

  reassignProjectEntries(input: { fromProjectId: string; toProjectId: string }): { mutatedIds: string[] } {
    const fromProjectId = normalizeWhitespace(input.fromProjectId);
    const toProjectId = normalizeWhitespace(input.toProjectId);
    if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) {
      return { mutatedIds: [] };
    }
    const entries = this.listMemoryEntries({
      kinds: ["project", "feedback"],
      scope: "project",
      projectId: fromProjectId,
      includeDeprecated: true,
      limit: 5000,
      offset: 0,
    });
    const mutatedIds: string[] = [];
    for (const entry of entries) {
      const record = this.getMemoryRecordsByIds([entry.relativePath], 5000)[0];
      if (!record) continue;
      this.writeRecord({
        relativePath: entry.relativePath,
        frontmatter: {
          ...record,
          projectId: toProjectId,
          updatedAt: nowIso(),
        },
        body: record.content,
      });
      mutatedIds.push(entry.relativePath);
    }
    return { mutatedIds };
  }

  archiveTmpEntries(_: { relativePaths: string[]; targetProjectId?: string; newProjectName?: string }): {
    mutatedIds: string[];
    targetProjectId?: string;
    createdProjectId?: string;
  } {
    throw new Error("archive_tmp is not supported in EdgeClaw current-project memory mode");
  }

  listProjectMetas(_options: { includeTmp?: boolean } = {}): ProjectMetaRecord[] {
    if (!this.manageProjectMeta) return [];
    if (this.isGeneralMode()) {
      const ids = this.listGeneralProjectMetaEntries().map(entry => entry.relativePath);
      return this.getMemoryRecordsByIds(ids, 5000)
        .map(record => this.toGeneralProjectMetaRecord(record))
        .filter((record): record is ProjectMetaRecord => Boolean(record));
    }
    const meta = this.readProjectMetaFile();
    return meta ? [meta] : [];
  }

  listProjectIdentityHints(_options: { includeTmp?: boolean; limit?: number } = {}): ProjectIdentityHint[] {
    if (!this.manageProjectMeta) return [];
    if (this.isGeneralMode()) {
      return this.listProjectMetas().map(projectMeta => ({
        identityKey: projectMeta.projectId,
        projectId: projectMeta.projectId,
        projectName: projectMeta.projectName,
        description: projectMeta.description,
        updatedAt: projectMeta.updatedAt,
        scope: "formal",
      }));
    }
    const meta = this.readProjectMetaFile();
    if (!meta) return [];
    const projectMeta = meta;
    return [
      {
        identityKey: CURRENT_PROJECT_ID,
        projectId: CURRENT_PROJECT_ID,
        projectName: projectMeta.projectName,
        description: projectMeta.description,
        updatedAt: projectMeta.updatedAt,
        scope: "formal",
      },
    ];
  }

  getProjectMeta(projectId = CURRENT_PROJECT_ID): ProjectMetaRecord | undefined {
    if (!this.manageProjectMeta) return undefined;
    const normalized = normalizeWhitespace(projectId);
    if (this.isGeneralMode()) {
      return this.listProjectMetas().find(meta => meta.projectId === normalized);
    }
    if (normalized && normalized !== CURRENT_PROJECT_ID) return undefined;
    return this.readProjectMetaFile();
  }

  hasVisibleProjectMemory(projectId = CURRENT_PROJECT_ID): boolean {
    if (!this.manageProjectFiles) return false;
    const normalized = normalizeWhitespace(projectId);
    if (normalized && !this.isGeneralMode() && normalized !== CURRENT_PROJECT_ID) return false;
    return this.collectAllEntries().some(
      entry =>
        entry.scope === "project" &&
        entry.type !== "general_project_meta" &&
        !entry.deprecated &&
        (!normalized || (entry.projectId || CURRENT_PROJECT_ID) === normalized),
    );
  }

  listTmpEntries(_limit = 500): MemoryManifestEntry[] {
    return [];
  }

  editProjectMeta(input: {
    projectId?: string;
    projectName: string;
    description: string;
    status: string;
  }): ProjectMetaRecord {
    if (!this.manageProjectMeta) {
      throw new Error("Project metadata is disabled for this store");
    }
    const normalizedProjectId = normalizeWhitespace(input.projectId);
    if (this.isGeneralMode()) {
      if (!normalizedProjectId) {
        throw new Error("projectId is required for General project metadata edits");
      }
      const existing = this.getProjectMeta(normalizedProjectId);
      if (!existing) {
        throw new Error(`Unknown projectId: ${input.projectId}`);
      }
      return this.upsertGeneralProjectMeta({
        projectId: normalizedProjectId,
        projectName: input.projectName,
        description: input.description,
        status: input.status,
        ...(existing.sourceKind ? { sourceKind: existing.sourceKind } : {}),
        ...(existing.sourceWorkspacePath ? { sourceWorkspacePath: existing.sourceWorkspacePath } : {}),
        ...(existing.sourceProjectId ? { sourceProjectId: existing.sourceProjectId } : {}),
        ...(existing.dreamUpdatedAt ? { dreamUpdatedAt: existing.dreamUpdatedAt } : {}),
      });
    }
    if (normalizedProjectId && normalizedProjectId !== CURRENT_PROJECT_ID) {
      throw new Error(`Unknown projectId: ${input.projectId}`);
    }
    return this.upsertProjectMeta({
      projectName: input.projectName,
      description: input.description,
      status: input.status,
    });
  }

  exportBundleRecords(_options: { includeTmp?: boolean } = {}): {
    memoryFiles: MemoryFileExportRecord[];
    projectMetas: ProjectMetaExportRecord[];
  } {
    const projectMetas = this.listProjectMetas();
    return {
      memoryFiles: this.getMemoryRecordsByIds(
        this.collectAllEntries().map(entry => entry.relativePath),
        5000,
      ).map(record => ({
        name: record.name,
        description: record.description,
        type: record.type,
        scope: record.scope,
        ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
        ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
        ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
        ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
        updatedAt: record.updatedAt,
        ...(record.dreamUpdatedAt ? { dreamUpdatedAt: record.dreamUpdatedAt } : {}),
        ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
        ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
        ...(typeof record.deprecated === "boolean" ? { deprecated: record.deprecated } : {}),
        ...(typeof record.dreamAttempts === "number" ? { dreamAttempts: record.dreamAttempts } : {}),
        file: record.file,
        relativePath: record.relativePath,
        content: record.content,
      })),
      projectMetas: projectMetas.map(projectMeta => ({
        projectId: projectMeta.projectId,
        projectName: projectMeta.projectName,
        description: projectMeta.description,
        status: projectMeta.status,
        createdAt: projectMeta.createdAt,
        updatedAt: projectMeta.updatedAt,
        ...(projectMeta.dreamUpdatedAt ? { dreamUpdatedAt: projectMeta.dreamUpdatedAt } : {}),
        relativePath: projectMeta.relativePath,
      })),
    };
  }

  exportSnapshotFiles(): MemorySnapshotFileRecord[] {
    if (this.enableManifest) {
      this.repairManifests();
    }
    const files = [
      ...(this.enableManifest ? [MANIFEST_FILE] : []),
      ...(!this.isGeneralMode() && this.readProjectMetaFile() ? [PROJECT_META_FILE] : []),
      ...this.collectAllEntries().map(entry => entry.relativePath),
    ];
    return files.map(relativePath => ({
      relativePath,
      content: readFileSync(this.resolveRelativePath(relativePath), "utf8"),
    }));
  }

  clearAllData(options: { rebuildManifest?: boolean } = {}): void {
    rmSync(this.rootDir, { recursive: true, force: true });
    this.ensureLayout();
    if (options.rebuildManifest ?? true) {
      this.repairManifests();
    }
  }

  getOverview(lastDreamAt?: string): FileMemoryOverview {
    const entries = this.collectAllEntries();
    const activeEntries = entries.filter(entry => !entry.deprecated);
    const generalProjectMetas = activeEntries.filter(entry => entry.type === "general_project_meta");
    const changedFilesSinceLastDream = !lastDreamAt
      ? activeEntries.length
      : activeEntries.filter(entry => entry.updatedAt > lastDreamAt).length;
    return {
      totalFiles: activeEntries.length,
      projectMemories: activeEntries.filter(entry => entry.type === "project").length,
      feedbackMemories: activeEntries.filter(entry => entry.type === "feedback").length,
      userProfiles: activeEntries.filter(entry => entry.type === "user").length,
      changedFilesSinceLastDream,
      tmpTotalFiles: 0,
      tmpFeedbackMemories: 0,
      tmpProjectMemories: 0,
      projectMetaCount: this.isGeneralMode() ? generalProjectMetas.length : this.readProjectMetaFile() ? 1 : 0,
      ...(this.isGeneralMode() ? { generalProjectMetaCount: generalProjectMetas.length } : {}),
      ...(activeEntries[0]?.updatedAt ? { latestMemoryAt: activeEntries[0].updatedAt } : {}),
    };
  }

  getSnapshotVersion(lastDreamAt?: string): string {
    const payload = JSON.stringify({
      lastDreamAt: lastDreamAt ?? "",
      files: this.exportSnapshotFiles(),
    });
    return hashText(payload);
  }

  mergeDuplicateEntries(entries: MemoryManifestEntry[]): {
    merged: number;
    changedFiles: string[];
    deletedFiles: string[];
  } {
    const groups = new Map<string, MemoryManifestEntry[]>();
    for (const entry of entries.filter(
      item => !item.deprecated && item.type !== "user" && item.type !== "general_project_meta",
    )) {
      const key = `${entry.type}:${slugify(entry.name)}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(entry);
      groups.set(key, bucket);
    }

    let merged = 0;
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      const records = this.getMemoryRecordsByIds(
        bucket.map(entry => entry.relativePath),
        5000,
      ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const primary = records[0];
      if (!primary) continue;
      let mergedCandidate = this.toCandidate(primary);
      for (const record of records.slice(1)) {
        mergedCandidate = mergeCandidates(mergedCandidate, this.toCandidate(record));
      }
      this.writeRecord({
        relativePath: primary.relativePath,
        frontmatter: {
          ...primary,
          ...(primary.scope === "project" && primary.projectId ? { projectId: primary.projectId } : {}),
          updatedAt: nowIso(),
          description: candidateDescription(mergedCandidate),
          dreamAttempts: typeof primary.dreamAttempts === "number" ? primary.dreamAttempts + 1 : 1,
        },
        body: buildRecordBody(mergedCandidate),
      });
      changedFiles.push(primary.relativePath);
      for (const duplicate of records.slice(1)) {
        const absolutePath = this.resolveRelativePath(duplicate.relativePath);
        if (existsSync(absolutePath)) {
          unlinkSync(absolutePath);
          deletedFiles.push(duplicate.relativePath);
        }
      }
      merged += 1;
    }

    if (merged > 0 || deletedFiles.length > 0) {
      this.repairManifests();
    }

    return {
      merged,
      changedFiles,
      deletedFiles,
    };
  }
}
