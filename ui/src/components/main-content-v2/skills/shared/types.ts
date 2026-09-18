/**
 * Skills 面板各子组件共享的类型。
 *
 * 从 `SkillsV2.tsx` 搬出（#159 UI-APP-N01 切片 A）：这些类型同时被面板本体与
 * `skills/import/` 的子组件使用，若留在 `SkillsV2.tsx` 里由子组件反向导入会形成
 * 循环依赖，故先移到共享模块。**被搬声明逐字未改**（仅新增 `export`）。
 */

export type SkillScope = "builtin" | "user" | "project";

export type SkillTemplateMeta = {
  mode?: string;
  scenario?: string;
  surface?: string;
  preview?: string;
  designSystem?: string;
};

export type Skill = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  skillFile: string;
  skillDir: string;
  scope: SkillScope;
  readonly: boolean;
  overriddenBy?: "user" | "project";
  overridesBuiltin?: boolean;
  mtime: number | null;
  template?: SkillTemplateMeta | null;
};

// ---------------------------------------------------------------------------
// New Skill modal — two tabs: Install from ClawHub, Create from scratch
// ---------------------------------------------------------------------------

export type NewModalCreated = { slug: string; name: string; scope: "user" | "project" };
