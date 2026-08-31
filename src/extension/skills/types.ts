/**
 * Public protocol types for the skill manager. These types are shared
 * between the gateway, its remote clients (UI server bridge), and any
 * future SDK consumer. They intentionally avoid leaking absolute paths
 * to outside callers — every operation is addressed by `(scope, slug)`
 * and the manager itself owns the path layout under `~/.sati/skills/`
 * and `<projectRoot>/.sati/skills/`.
 */

/**
 * "builtin" is shipped with Sati and is read-only. "user" lives in
 * `~/.sati/skills/`, available to every project. "project" lives in
 * `<projectRoot>/.sati/skills/`, scoped to the active project.
 */
export type SkillScope = "builtin" | "user" | "project";

/**
 * Lightweight summary used by `list` / `create` / `write` responses.
 * Mirrors what the UI needs to render a sidebar row: name +
 * description for display, slug for routing, mtime for sort. The
 * absolute path is included so the UI can show it in the detail
 * header — it's the same field SkillsV2.tsx already binds to.
 */
/** 角色配置（SKILL.md frontmatter `type: "role"` 时的可选角色字段）。 */
export type SkillRoleConfig = {
  /** 角色工具白名单（缺省 ["*"]，对应子代理 allowedTools）。 */
  tools?: string[];
  /** 业务域白名单（visibleDomains，仅暴露这些 domain 的工具）。 */
  domains?: string[];
  /** 额外排除的工具名（在子代理硬性剔除之外）。 */
  omitTools?: string[];
  /** 只读角色（拒绝破坏性工具调用）。 */
  readOnly?: boolean;
  /** 角色专属系统提示段（追加到子代理共享前缀之后）。 */
  systemPrompt?: string;
  /**
   * 知识接线声明（可选）：角色启动时把必查知识需求编译进系统提示，
   * 使子代理 turn 0 即携带知识检索指令（而非依赖撞 query）。
   * 声明内容仅供角色自身上下文使用，不改变工具可见性。
   */
  knowledge?: {
    /** 必查 wiki 卡片（wiki 根相对路径 id 或自由文本检索词，经 patent_wiki_search 检索）。 */
    cards?: string[];
    /** 是否需要检索相似在先判例（patent_case_search，如 OA/无效类角色）。 */
    requireCaseSearch?: boolean;
    /** 是否需要核验法条原文（law_search）。 */
    requireLawSearch?: boolean;
  };
  /**
   * 输出契约（可选）：声明角色应产出的结论结构。`schema` 为 JSON Schema 子集
   *（校验/程序化消费，"缺字段即提示"）；`template` 为宽松 Markdown 骨架
   *（纯文本产出时给出段落提示）。二者可同时声明，schema 优先用于校验。
   */
  output?: {
    /** JSON Schema 子集，描述角色结论的结构化字段与 required。 */
    schema?: unknown;
    /** 宽松 Markdown 模板，描述结论段落骨架。 */
    template?: string;
  };
};

/** HTML 模板 mode 的合法取值。 */
export const TEMPLATE_MODES = [
  "doc",
  "deck",
  "data-report",
  "poster",
  "social-card",
  "prototype",
  "office",
  "frame",
] as const;

/** HTML 模板 scenario 的合法取值。 */
export const TEMPLATE_SCENARIOS = ["patent", "legal", "finance", "product", "operation", "design", "personal"] as const;

/** HTML 模板 surface 的合法取值。 */
export const TEMPLATE_SURFACES = ["long-page", "a4", "16:9", "1600x900", "1080x1920", "auto"] as const;

/** HTML 模板元数据（可选，供模板筛选/UI 标签展示）。 */
export type SkillTemplateMeta = {
  mode?: (typeof TEMPLATE_MODES)[number];
  scenario?: (typeof TEMPLATE_SCENARIOS)[number];
  surface?: (typeof TEMPLATE_SURFACES)[number];
  preview?: string;
  designSystem?: string;
};

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  /** Absolute path of the SKILL.md file. */
  skillFile: string;
  /** Absolute path of the containing skill directory. */
  skillDir: string;
  scope: SkillScope;
  /** Built-in skills are immutable; user/project skills remain editable. */
  readonly: boolean;
  /** Higher-priority scope currently shadowing this entry, when any. */
  overriddenBy?: "user" | "project";
  /** True when this entry shadows a bundled skill with the same slug. */
  overridesBuiltin?: boolean;
  /** Last-modified time of SKILL.md in epoch ms, or null if unreadable. */
  mtime: number | null;
  /** `type: "role"` 时的角色配置；普通 skill 为 null。 */
  role?: SkillRoleConfig | null;
  /** HTML 模板元数据；非 HTML 模板为 null。 */
  template?: SkillTemplateMeta | null;
};

export type SkillsListInput = {
  /**
   * Absolute path of the active project. When omitted (or set to a
   * "general chat" marker the caller filters out), only user-scope
   * skills are returned.
   */
  projectKey?: string | null;
};

export type SkillsListResult = {
  builtin: SkillSummary[];
  user: SkillSummary[];
  project: SkillSummary[];
  /** Echoed back so the UI can confirm which project the list came from. */
  projectPath: string | null;
};

export type SkillAddressInput = {
  scope: SkillScope;
  slug: string;
  /** Required when `scope === "project"`. */
  projectKey?: string | null;
};

export type SkillReadResult = {
  content: string;
  scope: SkillScope;
  slug: string;
  skill: SkillSummary | null;
};

export type SkillWriteInput = SkillAddressInput & { content: string };
export type SkillWriteResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
  skill: SkillSummary | null;
};

export type SkillCreateInput = SkillAddressInput & {
  name?: string;
  description?: string;
  body?: string;
  /**
   * Full SKILL.md content. When provided, name/description/body are
   * ignored. Used by the "Import from folder" flow that already has
   * a complete document to write.
   */
  content?: string;
};

export type SkillCreateResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
  /** Absolute path of the created skill directory. */
  skillPath: string;
  skill: SkillSummary | null;
};

export type SkillDeleteInput = SkillAddressInput;
export type SkillDeleteResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
};

/** Issue raised by the compliance validator. */
export type SkillValidationIssue = { code: string; message: string };

export type SkillValidationResult = {
  /** False when at least one hard-fail issue is present. */
  ok: boolean;
  hardFails: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
  stats: { fileCount: number; totalBytes: number };
  /** Parsed frontmatter when the SKILL.md was readable, otherwise null. */
  frontmatter: Record<string, unknown> | null;
  /**
   * Echoed back when the validator was given an on-disk source so the
   * UI can show what was checked.
   */
  sourcePath?: string;
};

export type SkillValidateInput =
  | { sourcePath: string }
  | {
      /**
       * Raw SKILL.md content from the browser folder picker. Required when
       * `files` is provided; otherwise the validator only checks the file
       * list for size/safety.
       */
      skillMdContent?: string;
      files: Array<{ relativePath: string; size: number }>;
    };

export type SkillImportInput = {
  /**
   * Absolute path to the source folder containing SKILL.md.  Supports
   * `~` expansion at the manager level.
   */
  sourcePath: string;
  /** Defaults to the source folder basename. */
  slug?: string;
  scope: SkillScope;
  projectKey?: string | null;
  /**
   * "copy" recursively copies the source folder. "symlink" makes a
   * symlink pointing at the source — edits in either location stay in
   * sync at the cost of breaking the skill if the source moves.
   */
  mode?: "copy" | "symlink";
  /** Overwrite an existing target directory. */
  force?: boolean;
};

export type SkillImportResult = {
  ok: true;
  mode: "copy" | "symlink";
  scope: SkillScope;
  slug: string;
  sourcePath: string;
  /** Absolute path of the imported skill directory. */
  skillPath: string;
  skill: SkillSummary | null;
  validation: SkillValidationResult;
};

export type SkillScanInput = { parentPath: string };

export type SkillScanFolder = {
  folderName: string;
  hasSkillMd: boolean;
  name: string | null;
  description: string | null;
  sourcePath: string;
  fileCount: number;
  totalSize: number;
};

export type SkillScanResult = {
  parentPath: string;
  folders: SkillScanFolder[];
};
