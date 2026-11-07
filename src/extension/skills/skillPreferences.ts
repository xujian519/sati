import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 按技能持久开关（`~/.sati/skill-preferences.json`）。
 *
 * 三层优先级：project（当前项目）> user > builtin；缺省启用。文件损坏或
 * 不可读时 fail-open（全部按启用处理），避免升级/手改文件后技能整体消失。
 *
 * 写入用临时文件 + rename，权限 0600。
 */
export type SkillPreferenceScope = "builtin" | "user" | "project";

export type SkillPreferencesFile = {
  version: 1;
  builtin: Record<string, boolean>;
  user: Record<string, boolean>;
  project: Record<string, Record<string, boolean>>;
};

export type SetSkillEnabledInput = {
  scope: SkillPreferenceScope;
  slug: string;
  projectKey?: string | null;
  enabled: boolean;
};

const PREFERENCES_FILENAME = "skill-preferences.json";
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

export function emptySkillPreferences(): SkillPreferencesFile {
  return { version: 1, builtin: {}, user: {}, project: {} };
}

export function skillPreferencesPath(pilotHome: string): string {
  return join(resolve(pilotHome), PREFERENCES_FILENAME);
}

export class SkillPreferenceStore {
  private readonly filePath: string;
  private data: SkillPreferencesFile;
  private loadedMtimeMs: number | undefined;

  constructor(pilotHome: string, options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? skillPreferencesPath(pilotHome);
    this.data = this.read();
    this.loadedMtimeMs = this.currentMtimeMs();
  }

  /** 文件被外部修改后重新加载（每个 prompt 组装前调用一次）。 */
  refresh(): void {
    const mtimeMs = this.currentMtimeMs();
    if (mtimeMs === undefined || mtimeMs === this.loadedMtimeMs) {
      return;
    }
    this.data = this.read();
    this.loadedMtimeMs = mtimeMs;
  }

  /**
   * project 覆盖优先，其次 user，再次 builtin；没有记录即启用。
   * @param projectKey 当前项目绝对路径；general chat 传 null。
   */
  isEnabled(slug: string, projectKey?: string | null): boolean {
    if (projectKey) {
      const projectEntry = this.data.project[projectKey]?.[slug];
      if (projectEntry !== undefined) return projectEntry;
    }
    const userEntry = this.data.user[slug];
    if (userEntry !== undefined) return userEntry;
    const builtinEntry = this.data.builtin[slug];
    if (builtinEntry !== undefined) return builtinEntry;
    return true;
  }

  setEnabled(input: SetSkillEnabledInput): SkillPreferencesFile {
    if (!SLUG_RE.test(input.slug) || input.slug.includes("..")) {
      throw new Error(`Invalid skill slug: ${input.slug}`);
    }
    const next = this.clone();
    if (input.scope === "project") {
      if (!input.projectKey) {
        throw new Error("Project scope requires projectKey.");
      }
      const project = (next.project[input.projectKey] ??= {});
      project[input.slug] = input.enabled;
    } else {
      next[input.scope][input.slug] = input.enabled;
    }
    this.write(next);
    this.data = next;
    this.loadedMtimeMs = this.currentMtimeMs();
    return this.clone();
  }

  snapshot(): SkillPreferencesFile {
    return this.clone();
  }

  private read(): SkillPreferencesFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1) {
        return emptySkillPreferences();
      }
      return {
        version: 1,
        builtin: readBooleanRecord(parsed.builtin),
        user: readBooleanRecord(parsed.user),
        project: readProjectRecord(parsed.project),
      };
    } catch {
      // 缺失/坏 JSON/权限错误：fail-open，全部按启用处理。
      return emptySkillPreferences();
    }
  }

  private write(next: SkillPreferencesFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能未创建；忽略清理失败，原始错误更重要。
      }
      throw error;
    }
  }

  private currentMtimeMs(): number | undefined {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      // 文件不存在或不可读 → 视为未加载，返回 undefined 交给 refresh 重试。
      return undefined;
    }
  }

  private clone(): SkillPreferencesFile {
    return {
      version: 1,
      builtin: { ...this.data.builtin },
      user: { ...this.data.user },
      project: Object.fromEntries(
        Object.entries(this.data.project).map(([projectKey, entries]) => [projectKey, { ...entries }]),
      ),
    };
  }
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const output: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean" && SLUG_RE.test(key) && !key.includes("..")) {
      output[key] = entry;
    }
  }
  return output;
}

function readProjectRecord(value: unknown): Record<string, Record<string, boolean>> {
  if (!isRecord(value)) return {};
  const output: Record<string, Record<string, boolean>> = {};
  for (const [projectKey, entries] of Object.entries(value)) {
    output[projectKey] = readBooleanRecord(entries);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
