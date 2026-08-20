/**
 * 团队角色嵌套目录装配 — `skills/patent-teams/<岗>/SKILL.md` → 角色注册。
 *
 * `skills/` 加载路径（`discoverSkillPaths` / `SkillManager.scan`）只检查一层
 * 子目录是否含 SKILL.md；`skills/patent-teams/` 自身无 SKILL.md，整目录被跳过，
 * 其下 12 个团队岗位角色无法经插件贡献路径注册。
 *
 * 本模块为嵌套目录补一条遍历（M3 T15）：对 `skills/patent-teams/` 下每个含
 * SKILL.md 的子目录，走与插件贡献**同一**装配路径——frontmatter（yaml 解析）
 * → `parseRoleConfig` → `roleFromContribution` → `registerRoleDefinition`。
 * 不修改 `discoverSkillPaths` / `listSkillsIn` 的全局扫描（影响所有 skills
 * 加载路径，风险大），只在此处补充装配。
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { registerRoleDefinition } from "../agent/sub/builtinSubagentTypes.js";
import { roleFromContribution } from "../agent/sub/roleFromSkill.js";
import { isRoleFrontmatter, parseRoleConfig } from "../extension/skills/roleConfig.js";
import type { PluginSkillContribution } from "../extension/plugins/runtime/PluginRuntime.js";

/**
 * 注册 `builtinSkillsRoot/patent-teams` 下各子目录 SKILL.md 声明的全部团队角色。
 * 目录不存在或无可注册角色时静默返回 0（builtin skills 未挂载的场景不报错）。
 * @returns 本次注册的角色数。
 */
export function registerNestedTeamRoleDefinitions(builtinSkillsRoot: string | undefined): number {
  if (!builtinSkillsRoot) return 0;
  const teamRolesRoot = join(builtinSkillsRoot, "patent-teams");
  let entries: Dirent[];
  try {
    entries = readdirSync(teamRolesRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let registered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(teamRolesRoot, entry.name);
    let skillFile: string | undefined;
    try {
      skillFile = readdirSync(skillDir).find(name => /^skill\.md$/iu.test(name));
    } catch {
      continue;
    }
    if (!skillFile) continue;
    const contribution = loadNestedRoleContribution(entry.name, join(skillDir, skillFile));
    if (contribution === null) continue;
    const definition = roleFromContribution(contribution);
    if (definition === null) continue;
    registerRoleDefinition(definition);
    registered += 1;
  }
  return registered;
}

/** 读取并解析单个嵌套 SKILL.md 为角色贡献；非角色文件或解析失败返回 null。 */
function loadNestedRoleContribution(slug: string, skillFilePath: string): PluginSkillContribution | null {
  let raw: string;
  try {
    raw = readFileSync(skillFilePath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseSkillFrontmatter(raw);
  if (!isRoleFrontmatter(frontmatter)) return null;
  return {
    name: slug,
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    path: skillFilePath,
    role: parseRoleConfig(frontmatter),
  };
}

/**
 * 解析 SKILL.md 头部 YAML frontmatter（与 SkillManager 同款 yaml 解析：
 * 支持多行 systemPrompt 块 / 数组字段 / 嵌套结构；无前导 `---`、缺闭合围栏
 * 或 yaml 解析失败时返回空对象，调用方按非角色文件处理）。
 */
function parseSkillFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  // 兼容 `\n---\n` 与 `\n---`（无尾随换行）两种闭合围栏。
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
