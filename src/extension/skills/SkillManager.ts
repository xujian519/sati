import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getPilotExtensionPaths } from "../../shared/paths/index.js";
import { parseSkillFrontmatter } from "./frontmatter.js";
import { isRoleFrontmatter, parseRoleConfig } from "./roleConfig.js";
import { validateFromDisk, validateFromManifest } from "./validation.js";
import {
  TEMPLATE_MODES,
  TEMPLATE_SCENARIOS,
  TEMPLATE_SURFACES,
  type SkillAddressInput,
  type SkillCreateInput,
  type SkillCreateResult,
  type SkillDeleteInput,
  type SkillDeleteResult,
  type SkillImportInput,
  type SkillImportResult,
  type SkillReadResult,
  type SkillScanFolder,
  type SkillScanInput,
  type SkillScanResult,
  type SkillScope,
  type SkillSummary,
  type SkillTemplateMeta,
  type SkillValidateInput,
  type SkillValidationResult,
  type SkillWriteInput,
  type SkillWriteResult,
  type SkillsListInput,
  type SkillsListResult,
} from "./types.js";

/**
 * Slug rules — keep tight so the directory name is safe on every
 * filesystem we ship to (mac/linux/windows) and never composes into a
 * path-traversal payload.
 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/**
 * 单一事实源：迁移（migrateSkills）必须与导入（import/create）执行同一套
 * slug 规则，否则迁移产物会被 manager 拒绝列出。
 */
export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug) && !slug.includes("..");
}

/** Caps mirror the legacy `ui/server/routes/skills.js` limits. */

export type SkillManagerOptions = {
  /** Resolved `~/.sati` root. Required. */
  pilotHome: string;
  /** Read-only skills shipped with the active Sati build. */
  builtinSkillsRoot?: string;
  /**
   * "General chat" cwds we treat as not-a-real-project. Defaults to
   * `pilotHome` (~/.sati). When the caller passes a `projectKey`
   * matching one of these, the manager behaves as if no project was set —
   * built-in and user-scope skills are visible, but project skills are not.
   */
  generalCwdPaths?: string[];
};

/**
 * Authoritative skill-CRUD layer used by every host (gateway clients,
 * UI server, future SDK callers). Reads the release's bundled skill root and
 * owns the editable layouts under `~/.sati/skills/` (user scope) and
 * `<projectRoot>/.sati/skills/` (project scope). Legacy third-party skill
 * directories are intentionally not consulted — conflating them with
 * Sati's layout caused the UI/agent skill drift the migration fixes.
 */
export class SkillManager {
  private readonly pilotHome: string;
  private readonly builtinSkillsRootPath: string | null;
  private readonly generalCwdPaths: string[];

  constructor(options: SkillManagerOptions) {
    this.pilotHome = resolve(options.pilotHome);
    this.builtinSkillsRootPath = options.builtinSkillsRoot ? resolve(options.builtinSkillsRoot) : null;
    const defaults = [this.pilotHome];
    this.generalCwdPaths = (options.generalCwdPaths ?? defaults).map(p => resolve(p));
  }

  // -------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------

  private userSkillsRoot(): string {
    return getPilotExtensionPaths(this.pilotHome, this.pilotHome).globalSkillsDir;
  }

  private builtinSkillsRoot(): string {
    if (!this.builtinSkillsRootPath) {
      throw new SkillManagerError("not_configured", "Built-in skills root is not configured.");
    }
    return this.builtinSkillsRootPath;
  }

  private projectSkillsRoot(projectRoot: string): string {
    return getPilotExtensionPaths(projectRoot, this.pilotHome).projectSkillsDir;
  }

  private isGeneralCwd(projectKey: string | null | undefined): boolean {
    if (!projectKey) return false;
    return this.generalCwdPaths.includes(resolve(projectKey));
  }

  /** Resolve a `(scope, slug, projectKey)` triple to a target dir. */
  private resolveScopeRoot(scope: SkillScope, projectKey: string | null | undefined): string {
    if (scope === "builtin") {
      return this.builtinSkillsRoot();
    }
    if (scope === "project") {
      if (!projectKey || this.isGeneralCwd(projectKey)) {
        throw new SkillManagerError(
          "project_required",
          "Project scope requires a real project (general chat doesn't qualify).",
        );
      }
      return this.projectSkillsRoot(projectKey);
    }
    return this.userSkillsRoot();
  }

  private assertMutableScope(scope: SkillScope): void {
    if (scope === "builtin") {
      throw new SkillManagerError(
        "read_only",
        "Built-in skills are read-only. Create a user or project override to edit this skill.",
      );
    }
  }

  private resolveSkillDir(input: SkillAddressInput): string {
    if (!isValidSlug(input.slug)) {
      throw new SkillManagerError(
        "invalid_slug",
        `Invalid slug "${input.slug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      );
    }
    const root = this.resolveScopeRoot(input.scope, input.projectKey);
    return join(root, input.slug);
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async list(input: SkillsListInput): Promise<SkillsListResult> {
    const projectKey = input.projectKey ?? null;
    const effectiveProject = this.isGeneralCwd(projectKey) ? null : projectKey;

    const builtinSkills = this.builtinSkillsRootPath ? await listSkillsIn(this.builtinSkillsRootPath, "builtin") : [];
    const userSkills = await listSkillsIn(this.userSkillsRoot(), "user");
    const projectSkills = effectiveProject
      ? await listSkillsIn(this.projectSkillsRoot(effectiveProject), "project")
      : [];

    const builtinSlugs = new Set(builtinSkills.map(skill => skill.slug));
    const userSlugs = new Set(userSkills.map(skill => skill.slug));
    const projectSlugs = new Set(projectSkills.map(skill => skill.slug));

    return {
      builtin: builtinSkills.map(skill => ({
        ...skill,
        ...(projectSlugs.has(skill.slug)
          ? { overriddenBy: "project" as const }
          : userSlugs.has(skill.slug)
            ? { overriddenBy: "user" as const }
            : {}),
      })),
      user: userSkills.map(skill => ({
        ...skill,
        ...(builtinSlugs.has(skill.slug) ? { overridesBuiltin: true } : {}),
        ...(projectSlugs.has(skill.slug) ? { overriddenBy: "project" as const } : {}),
      })),
      project: projectSkills.map(skill => ({
        ...skill,
        ...(builtinSlugs.has(skill.slug) ? { overridesBuiltin: true } : {}),
      })),
      projectPath: effectiveProject,
    };
  }

  async read(input: SkillAddressInput): Promise<SkillReadResult> {
    const skillDir = this.resolveSkillDir(input);
    const skillFile = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("not_found", `SKILL.md not found at ${skillFile}.`);
      }
      throw e;
    }
    const skill = await readSkillMeta(skillDir, input.scope);
    return { content, scope: input.scope, slug: input.slug, skill };
  }

  async write(input: SkillWriteInput): Promise<SkillWriteResult> {
    this.assertMutableScope(input.scope);
    if (typeof input.content !== "string") {
      throw new SkillManagerError("invalid_input", "content (string) is required.");
    }
    const skillDir = this.resolveSkillDir(input);
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, input.content, "utf8");
    const skill = await readSkillMeta(skillDir, input.scope);
    return { ok: true, scope: input.scope, slug: input.slug, skill };
  }

  async create(input: SkillCreateInput): Promise<SkillCreateResult> {
    this.assertMutableScope(input.scope);
    const skillDir = this.resolveSkillDir(input);
    let exists = false;
    try {
      await fs.access(skillDir);
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
    if (exists) {
      throw new SkillManagerError("conflict", `Skill already exists at ${skillDir}.`);
    }
    await fs.mkdir(skillDir, { recursive: true });
    const finalContent =
      typeof input.content === "string" && input.content.trim()
        ? input.content
        : buildInitialSkillContent({
            slug: input.slug,
            name: input.name,
            description: input.description,
            body: input.body,
          });
    const skillFile = join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, finalContent, "utf8");
    const skill = await readSkillMeta(skillDir, input.scope);
    return {
      ok: true,
      scope: input.scope,
      slug: input.slug,
      skillPath: skillDir,
      skill,
    };
  }

  async delete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    this.assertMutableScope(input.scope);
    const skillDir = this.resolveSkillDir(input);
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { ok: true, scope: input.scope, slug: input.slug };
  }

  async validate(input: SkillValidateInput): Promise<SkillValidationResult> {
    if ("sourcePath" in input && typeof input.sourcePath === "string" && input.sourcePath.trim()) {
      const resolved = resolve(expandHome(input.sourcePath.trim()));
      const result = await validateFromDisk(resolved);
      return { ...result, sourcePath: resolved };
    }
    if ("files" in input && Array.isArray(input.files)) {
      return validateFromManifest(input.skillMdContent ?? "", input.files);
    }
    throw new SkillManagerError("invalid_input", "Provide either { sourcePath } or { skillMdContent, files: [...] }.");
  }

  async import(input: SkillImportInput): Promise<SkillImportResult> {
    this.assertMutableScope(input.scope);
    if (typeof input.sourcePath !== "string" || !input.sourcePath.trim()) {
      throw new SkillManagerError("invalid_input", "sourcePath is required.");
    }
    const importMode: "copy" | "symlink" = input.mode === "symlink" ? "symlink" : "copy";

    const resolvedSource = resolve(expandHome(input.sourcePath.trim()));
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(resolvedSource);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("source_missing", `Source path does not exist: ${resolvedSource}`);
      }
      throw e;
    }
    if (!stat.isDirectory()) {
      throw new SkillManagerError("source_not_directory", `Source path is not a directory: ${resolvedSource}`);
    }
    try {
      await fs.access(join(resolvedSource, "SKILL.md"));
    } catch {
      throw new SkillManagerError(
        "no_skill_md",
        `Source folder does not contain a SKILL.md at the root: ${resolvedSource}`,
      );
    }

    const inferredSlug = (input.slug && input.slug.trim()) || basename(resolvedSource);
    if (!isValidSlug(inferredSlug)) {
      throw new SkillManagerError(
        "invalid_slug",
        `Invalid slug "${inferredSlug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      );
    }

    const root = this.resolveScopeRoot(input.scope, input.projectKey);
    const targetDir = join(root, inferredSlug);

    if (resolve(targetDir) === resolvedSource) {
      throw new SkillManagerError(
        "self_import",
        "Source and target resolve to the same path; pick a different slug or scope.",
      );
    }

    let exists = false;
    try {
      await fs.access(targetDir);
      exists = true;
    } catch {
      // 目标路径不存在：视为无冲突，可安全创建（fail-open，access 失败即不存在）。
    }
    if (exists && !input.force) {
      throw new SkillManagerError(
        "conflict",
        `Skill already exists at ${targetDir}. Re-run with force=true to overwrite.`,
      );
    }

    const validation = await validateFromDisk(resolvedSource);
    if (!validation.ok) {
      throw new SkillValidationError(validation);
    }

    if (exists) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.mkdir(root, { recursive: true });

    if (importMode === "symlink") {
      await fs.symlink(resolvedSource, targetDir, "dir");
    } else {
      await fs.cp(resolvedSource, targetDir, {
        recursive: true,
        force: true,
        dereference: false,
        errorOnExist: false,
      });
    }

    const skill = await readSkillMeta(targetDir, input.scope);
    return {
      ok: true,
      mode: importMode,
      scope: input.scope,
      slug: inferredSlug,
      sourcePath: resolvedSource,
      skillPath: targetDir,
      skill,
      validation,
    };
  }

  async scan(input: SkillScanInput): Promise<SkillScanResult> {
    if (typeof input.parentPath !== "string" || !input.parentPath.trim()) {
      throw new SkillManagerError("invalid_input", "parentPath is required.");
    }
    const resolvedRoot = resolve(expandHome(input.parentPath.trim()));
    let entries: import("node:fs").Dirent[];
    try {
      const rootStat = await fs.stat(resolvedRoot);
      if (!rootStat.isDirectory()) {
        throw new SkillManagerError("not_directory", `Path is not a directory: ${resolvedRoot}`);
      }
      entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    } catch (e) {
      if (e instanceof SkillManagerError) throw e;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("not_found", `Directory not found: ${resolvedRoot}`);
      }
      throw e;
    }

    const currentFolder = await buildSkillScanFolder(resolvedRoot, basename(resolvedRoot));
    const childFolders: SkillScanFolder[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let isDir = entry.isDirectory();
      if (!isDir) isDir = await statIsDirectory(join(resolvedRoot, entry.name));
      if (!isDir) continue;

      const subDir = join(resolvedRoot, entry.name);
      childFolders.push(await buildSkillScanFolder(subDir, entry.name));
    }

    childFolders.sort((a, b) => {
      if (a.hasSkillMd !== b.hasSkillMd) return a.hasSkillMd ? -1 : 1;
      return a.folderName.localeCompare(b.folderName);
    });

    const folders = currentFolder.hasSkillMd ? [currentFolder, ...childFolders] : childFolders;

    return { parentPath: resolvedRoot, folders };
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Domain error carrying a stable machine-readable `code`. Hosts convert
 * this into 4xx HTTP responses or gateway error frames.
 */
export class SkillManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillManagerError";
  }
}

/**
 * Specialised error wrapping a validation result that failed the
 * hard-fail checks. Hosts can surface the structured `validation` payload
 * back to the UI so the user sees which specific rules were violated.
 */
export class SkillValidationError extends SkillManagerError {
  constructor(public readonly validation: SkillValidationResult) {
    super("validation_failed", "Validation failed.");
    this.name = "SkillValidationError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** stat 解析目录性：断链 / 不可读的 symlink 视为非目录（fail-safe 跳过）。 */
async function statIsDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build a fresh SKILL.md from user-supplied fields. We emit a minimal
 * YAML frontmatter block (just `name` and `description`) plus a markdown
 * body, matching what `ui/server/routes/skills.js` used to write so
 * exporters/diffs don't churn.
 */
function buildInitialSkillContent(input: { slug: string; name?: string; description?: string; body?: string }): string {
  const fmName = (input.name ?? input.slug).replace(/\n/g, " ").trim();
  const fmDesc = (input.description ?? "").replace(/\n/g, " ").trim();
  const lines: string[] = ["---", `name: ${fmName}`];
  if (fmDesc) lines.push(`description: ${fmDesc}`);
  lines.push("---", "", `# ${fmName}`, "");
  if (input.body && input.body.trim()) {
    lines.push(input.body.trim(), "");
  } else {
    lines.push("Describe what this skill does, when to invoke it, and any prerequisites.", "");
  }
  return lines.join("\n");
}

/** 从 frontmatter 取值并按白名单过滤枚举字段；缺失或非法时返回 undefined。 */
function pickTemplateField<T extends string>(
  fm: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = fm[key];
  if (typeof value !== "string") return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** 解析 HTML 模板元数据；未知枚举值降级为 undefined，不阻断加载。 */
function parseTemplateMeta(fm: Record<string, unknown>): SkillTemplateMeta | null {
  const mode = pickTemplateField(fm, "mode", TEMPLATE_MODES);
  const scenario = pickTemplateField(fm, "scenario", TEMPLATE_SCENARIOS);
  const surface = pickTemplateField(fm, "surface", TEMPLATE_SURFACES);
  const preview = typeof fm.preview === "string" ? fm.preview.trim() : undefined;
  const designSystem = typeof fm.design_system === "string" ? fm.design_system.trim() : undefined;
  if (
    mode === undefined &&
    scenario === undefined &&
    surface === undefined &&
    preview === undefined &&
    designSystem === undefined
  ) {
    return null;
  }
  const template: SkillTemplateMeta = {};
  if (mode !== undefined) template.mode = mode;
  if (scenario !== undefined) template.scenario = scenario;
  if (surface !== undefined) template.surface = surface;
  if (preview && !preview.includes("..") && !preview.startsWith("/")) {
    template.preview = preview;
  }
  if (designSystem) template.designSystem = designSystem;
  return template;
}

/** 解析 SKILL.md frontmatter 中的角色配置（type: "role"）；非法字段容错忽略。 */
async function readSkillMeta(skillDir: string, scope: SkillScope): Promise<SkillSummary | null> {
  const skillFile = join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = await fs.readFile(skillFile, "utf8");
  } catch {
    // SKILL.md 不可读（已删/权限）：返回 null，调用方跳过该条目，列表不被单个坏项阻断（fail-safe）。
    return null;
  }
  const fm = parseSkillFrontmatter(content);
  let mtime: number | null = null;
  try {
    const stat = await fs.stat(skillFile);
    mtime = stat.mtimeMs;
  } catch {
    // 读不到 mtime：置 null，仅影响排序展示，不影响技能加载（best-effort）。
  }
  const isRole = isRoleFrontmatter(fm);
  return {
    slug: basename(skillDir),
    name: typeof fm.name === "string" ? fm.name : basename(skillDir),
    description: typeof fm.description === "string" ? fm.description : "",
    version: typeof fm.version === "string" ? fm.version : typeof fm.version === "number" ? String(fm.version) : null,
    skillFile,
    skillDir,
    scope,
    readonly: scope === "builtin",
    mtime,
    role: isRole ? parseRoleConfig(fm) : null,
    template: parseTemplateMeta(fm),
  };
}

async function buildSkillScanFolder(skillDir: string, folderName: string): Promise<SkillScanFolder> {
  let hasSkillMd = false;
  let meta: SkillSummary | null = null;
  try {
    await fs.access(join(skillDir, "SKILL.md"));
    hasSkillMd = true;
    meta = await readSkillMeta(skillDir, "user");
  } catch {
    // 目录缺 SKILL.md：该文件夹不作为技能扫描（保守视无技能）。
  }

  let fileCount = 0;
  let totalSize = 0;
  if (hasSkillMd) {
    try {
      const files = await fs.readdir(skillDir, { recursive: true, withFileTypes: false });
      for (const file of files) {
        try {
          const stats = await fs.stat(join(skillDir, String(file)));
          if (stats.isFile()) {
            fileCount++;
            totalSize += stats.size;
          }
        } catch {
          // 单个文件 stat 失败：跳过该文件，fileCount/totalSize 少报仅影响展示（best-effort）。
        }
      }
    } catch {
      // readdir 失败：文件计数留 0，技能本体已由 readSkillMeta 读到，不影响加载（best-effort）。
    }
  }

  return {
    folderName,
    hasSkillMd,
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    sourcePath: skillDir,
    fileCount,
    totalSize,
  };
}

async function listSkillsIn(root: string, scope: SkillScope): Promise<SkillSummary[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!isValidSlug(entry.name)) continue;
    let isSkillDir = entry.isDirectory();
    if (!isSkillDir && entry.isSymbolicLink()) {
      // Accept symlinks-to-directories (the import-as-symlink path
      // creates these). Resolve and verify the target is a real dir.
      isSkillDir = await statIsDirectory(join(root, entry.name));
    }
    if (!isSkillDir) continue;
    const meta = await readSkillMeta(join(root, entry.name), scope);
    if (!meta) continue;
    skills.push(meta);
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}
