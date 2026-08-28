import { basename, dirname, join, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../../../telemetry/index.js";

const logger = createLogger("plugin-loader");

export type LoadedPluginCommand = {
  name: string;
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  isSkill: boolean;
};

export async function loadPluginCommands(options: {
  pluginName: string;
  baseDir: string;
}): Promise<LoadedPluginCommand[]> {
  const files = await collectMarkdownFiles(options.baseDir);
  return Promise.all(
    files.map(filePath =>
      loadMarkdownContribution(filePath, getPluginCommandName(options.pluginName, filePath, options.baseDir)),
    ),
  );
}

/**
 * Load the single root SKILL.md from a standalone skill directory.
 *
 * Standalone skills are not plugin namespaces: their directory slug is the
 * model-facing identifier. Loading the whole directory through
 * `loadPluginCommands` would both derive a bogus `..` namespace for the root
 * file and expose reference markdown files as additional skills.
 */
export async function loadStandaloneSkill(options: { name: string; skillDir: string }): Promise<LoadedPluginCommand> {
  const entries = await readdir(options.skillDir);
  const skillFileName = entries.find(entry => /^skill\.md$/iu.test(entry));
  if (!skillFileName) {
    throw new Error(`Standalone skill '${options.name}' has no SKILL.md.`);
  }
  return loadMarkdownContribution(join(options.skillDir, skillFileName), options.name);
}

export function getPluginCommandName(pluginName: string, filePath: string, baseDir: string): string {
  const skillFile = isSkillFile(filePath);
  const contributionDir = dirname(filePath);
  const baseName = skillFile ? basename(contributionDir) : basename(filePath).replace(/\.md$/iu, "");
  const namespaceRoot =
    skillFile && relative(baseDir, contributionDir) !== "" ? dirname(contributionDir) : contributionDir;
  const namespace = relative(baseDir, namespaceRoot).split(/[\\/]/u).filter(Boolean).join(":");

  return namespace ? `${pluginName}:${namespace}:${baseName}` : `${pluginName}:${baseName}`;
}

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/iu.test(basename(filePath));
}

async function loadMarkdownContribution(filePath: string, name: string): Promise<LoadedPluginCommand> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseMarkdownFrontmatter(raw, filePath);
  return {
    name,
    path: filePath,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    isSkill: isSkillFile(filePath),
  };
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // 贡献目录（commands/skills/output-styles）不存在：按空集合处理（可省略目录）。
    return output;
  }

  for (const entry of entries) {
    // join 而非字符串模板：Windows 上模板产生混合分隔符（`\dir/file`），
    // 返回的 path 不稳定，且与 readFile/stat 接受的规范形式不一致。
    const fullPath = join(directory, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      // 条目 stat 失败（竞态删除/权限）：跳过该条目（fail-safe）。
      continue;
    }
    if (entryStat.isDirectory()) {
      output.push(...(await collectMarkdownFiles(fullPath)));
    } else if (/\.md$/iu.test(entry)) {
      output.push(fullPath);
    }
  }
  return output;
}

function parseMarkdownFrontmatter(
  raw: string,
  filePath: string,
): { frontmatter: Record<string, unknown>; content: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, content: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw.slice(4, end)) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (error) {
    // 非法 yaml：记录 warn 后降级为空对象（既有「解析失败不抛错」契约保持；
    // warn 风格对齐 src/cli/teamRoleAssembly.ts parseSkillFrontmatter）
    logger.warn(`frontmatter yaml 解析失败，降级为空对象: ${filePath}`, error);
  }
  return { frontmatter, content: raw.slice(end + 5) };
}
