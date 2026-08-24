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
 *
 * 优先级语义：嵌套内置角色在插件贡献角色之后注册（Map.set 覆盖同名 id），
 * 内置团队角色优先于同名插件贡献角色（已核实：当前 12 岗 id 与顶层 skills/
 * 及插件技能无冲突）。
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { registerRoleDefinition } from "../agent/sub/builtinSubagentTypes.js";
import { roleFromContribution } from "../agent/sub/roleFromSkill.js";
import { isRoleFrontmatter, parseRoleConfig } from "../extension/skills/roleConfig.js";
import type { PluginSkillContribution } from "../extension/plugins/runtime/PluginRuntime.js";
import { createLogger } from "../telemetry/index.js";

const logger = createLogger("sati");

/**
 * 注册 `builtinSkillsRoot/patent-teams` 下各子目录 SKILL.md 声明的全部团队角色。
 * 目录不存在（builtin skills 未挂载 patent-teams 资产）时静默返回 0；读取到但
 * 单个资产异常（目录/文件读取失败、frontmatter yaml 解析失败）时记录 warn 后
 * 跳过，合法资产不受影响。
 * @returns 本次注册的角色数。
 */
export function registerNestedTeamRoleDefinitions(builtinSkillsRoot: string | undefined): number {
  if (!builtinSkillsRoot) return 0;
  const teamRolesRoot = join(builtinSkillsRoot, "patent-teams");
  let entries: Dirent[];
  try {
    entries = readdirSync(teamRolesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    // ENOENT = 本 build 未携带 patent-teams 资产（正常场景，静默）；其他异常暴露。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`读取团队角色目录失败，跳过: ${teamRolesRoot}`, error);
    }
    return 0;
  }
  let registered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(teamRolesRoot, entry.name);
    let skillFile: string | undefined;
    try {
      skillFile = readdirSync(skillDir).find(name => /^skill\.md$/iu.test(name));
    } catch (error) {
      logger.warn(`跳过非法团队角色资产（目录读取失败）: ${skillDir}`, error);
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

/** 读取并解析单个嵌套 SKILL.md 为角色贡献；非角色文件返回 null（读取异常已 warn）。 */
function loadNestedRoleContribution(slug: string, skillFilePath: string): PluginSkillContribution | null {
  let raw: string;
  try {
    raw = readFileSync(skillFilePath, "utf8");
  } catch (error) {
    logger.warn(`跳过非法团队角色资产（文件读取失败）: ${skillFilePath}`, error);
    return null;
  }
  const frontmatter = parseSkillFrontmatter(raw, skillFilePath);
  if (!isRoleFrontmatter(frontmatter)) return null;
  return {
    name: slug,
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    path: skillFilePath,
    role: parseRoleConfig(frontmatter),
  };
}

/**
 * 解析 SKILL.md 头部 YAML frontmatter。实现与 SkillManager 的
 * `parseSkillFrontmatterWithMeta` 同构（yaml 解析，支持多行 systemPrompt 块 /
 * 数组字段 / 嵌套结构），但**无 `parseCompatFrontmatter` 兼容回退**：yaml 解析
 * 抛错时记录 warn 并返回空对象，调用方按非角色文件跳过；无前导 `---` 或缺闭合
 * 围栏同样返回空对象（普通技能文件，不 warn）。
 */
function parseSkillFrontmatter(content: string, sourcePath: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  // 兼容 `\n---\n` 与 `\n---`（无尾随换行）两种闭合围栏。
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    logger.warn(`跳过非法团队角色资产（frontmatter yaml 解析失败）: ${sourcePath}`, error);
    return {};
  }
}
