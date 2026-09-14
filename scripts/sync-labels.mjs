#!/usr/bin/env node
/**
 * 标签体系门禁与同步器。
 *
 * `.github/labels.yml` 是标签体系的单一事实源，本脚本负责两件事：
 *
 *   node scripts/sync-labels.mjs           # 同步：把清单 upsert 到仓库（幂等，需 gh 已登录）
 *   node scripts/sync-labels.mjs --check   # 门禁：校验清单与 issue 模板一致（挂 pnpm lint）
 *
 * `--check` 拦截四类漂移：
 *   1. 清单自身不合规——标签名重复/为空，color 非 6 位 hex，description 为空或超长（GitHub 上限 100）。
 *   2. 模板引用了未声明的标签——`.github/ISSUE_TEMPLATE/*.md` frontmatter 的 `labels:` 必须在清单中。
 *   3. 模板的「影响 scope」勾选项与 `scope:*` 标签集合不一致（双向：模板多出/标签多出都拦）。
 *   4. 带前缀标签（`status:` / `priority:` / `scope:`）缺取值。
 *
 * 第 3 条是这套门禁的核心价值：issue 模板里的 scope 复选框会被
 * `scripts/classify-issue.mjs` 翻译成 `scope:*` 标签，两处一旦漂移，
 * 自动打标签就会静默失效——所以让它在 lint 阶段就红。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABELS_FILE = ".github/labels.yml";
const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

/** GitHub 标签描述上限。 */
const DESCRIPTION_MAX = 100;

/**
 * 解析 issue 模板的 YAML frontmatter。
 * @param {string} markdown 模板全文
 * @returns {Record<string, unknown>|null} frontmatter 对象，无则 null
 */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  return parseYaml(match[1]) ?? {};
}

/**
 * 取 markdown 中某个二级标题节的正文（到下一个二级标题或文末）。
 * @param {string} markdown 全文
 * @param {string} title 二级标题文本（不含 `## `）
 * @returns {string|null} 节正文，找不到该节则 null
 */
export function extractSection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${title}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * 把模板 scope 勾选项归一化为标签名片段。
 * 「其他」是模板里唯一的中文选项，固定映射为 `other`；用户可能在其后补写内容
 * （`其他: 桌面端`），因此按前缀识别而非全等（模板与清单两侧共用此约定）。
 * @param {string} text 勾选项文本（可能带 HTML 注释与尾随冒号）
 * @returns {string|null} 归一化名称，空则 null
 */
export function normalizeScopeOption(text) {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("其他")) return "other";
  return cleaned.toLowerCase();
}

/**
 * 提取模板「影响 scope」节的勾选项。
 * @param {string} markdown 模板全文
 * @returns {string[]} 归一化后的 scope 名列表（保持模板顺序）
 */
export function parseScopeOptions(markdown) {
  const section = extractSection(markdown, "影响 scope");
  if (section === null) return [];
  return section
    .split(/\r?\n/)
    .map(line => /^\s*-\s*\[[ xX]\]\s*(.+?)\s*$/.exec(line))
    .filter(match => match !== null)
    .map(match => normalizeScopeOption(match[1]))
    .filter(name => name !== null);
}

/**
 * 读取标签清单。文件缺失或结构非法时抛错（门禁宁可 fail-loud）。
 * @param {string} root 仓库根目录
 * @returns {Array<{name: string, color: string, description: string}>}
 */
export function loadLabels(root) {
  const parsed = parseYaml(readFileSync(join(root, LABELS_FILE), "utf8"));
  if (!Array.isArray(parsed?.labels)) {
    throw new Error(`${LABELS_FILE}: 顶层缺少 labels 数组`);
  }
  return parsed.labels;
}

/**
 * 读取全部 issue 模板（frontmatter labels + scope 勾选项）。
 * @param {string} root 仓库根目录
 * @returns {Array<{file: string, labels: string[], scopes: string[]}>}
 */
export function loadTemplates(root) {
  const dir = join(root, TEMPLATE_DIR);
  return readdirSync(dir)
    .filter(file => file.endsWith(".md"))
    .sort()
    .map(file => {
      const markdown = readFileSync(join(dir, file), "utf8");
      const frontmatter = parseFrontmatter(markdown);
      const labels = Array.isArray(frontmatter?.labels) ? frontmatter.labels : [];
      return { file, labels, scopes: parseScopeOptions(markdown) };
    });
}

/**
 * 校验标签清单与模板的一致性。
 * @param {Array<{name: string, color: string, description: string}>} labels 清单标签
 * @param {Array<{file: string, labels: string[], scopes: string[]}>} templates 模板
 * @returns {string[]} 错误消息列表（空数组 = 通过）
 */
export function validateLabels(labels, templates) {
  const errors = [];
  const seen = new Set();

  for (const label of labels) {
    const name = typeof label?.name === "string" ? label.name : "";
    if (!name) {
      errors.push("存在 name 为空的标签条目");
      continue;
    }
    if (seen.has(name)) errors.push(`标签名重复：${name}`);
    seen.add(name);

    if (typeof label.color !== "string" || !/^[0-9a-f]{6}$/i.test(label.color)) {
      errors.push(`标签 ${name} 的 color 必须是 6 位 hex（不含 #），当前：${String(label.color)}`);
    }
    const description = typeof label.description === "string" ? label.description : "";
    if (!description) {
      errors.push(`标签 ${name} 缺少 description`);
    } else if (description.length > DESCRIPTION_MAX) {
      errors.push(`标签 ${name} 的 description 超长（${description.length} > ${DESCRIPTION_MAX}）`);
    }

    const prefix = /^(status|priority|scope):/.exec(name);
    if (prefix && name.slice(prefix[0].length).trim() === "") {
      errors.push(`标签 ${name} 的前缀 ${prefix[0]} 后缺取值`);
    }
  }

  // 模板 frontmatter 引用的标签必须已声明，否则 GitHub 会静默忽略未知标签。
  for (const template of templates) {
    for (const label of template.labels) {
      if (!seen.has(label)) {
        errors.push(`${TEMPLATE_DIR}/${template.file} 引用了未声明的标签：${label}`);
      }
    }
  }

  // 模板 scope 勾选项 ↔ scope:* 标签，双向一致。
  const declaredScopes = new Set(
    labels.map(label => label?.name).filter(name => typeof name === "string" && name.startsWith("scope:")),
  );
  const templateScopes = new Set(templates.flatMap(template => template.scopes));
  for (const scope of templateScopes) {
    if (!declaredScopes.has(`scope:${scope}`)) {
      errors.push(`模板勾选项「${scope}」没有对应的 scope:${scope} 标签声明`);
    }
  }
  for (const name of declaredScopes) {
    if (!templateScopes.has(name.slice("scope:".length))) {
      errors.push(`标签 ${name} 在 issue 模板的「影响 scope」节中没有对应勾选项`);
    }
  }

  return errors;
}

// 仅当直接以脚本运行时执行 CLI 逻辑；被 import 时不触发副作用。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const checkOnly = process.argv.includes("--check");

  let labels;
  let templates;
  try {
    labels = loadLabels(ROOT);
    templates = loadTemplates(ROOT);
  } catch (error) {
    console.error(`✗ 读取标签清单失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (checkOnly) {
    const errors = validateLabels(labels, templates);
    if (errors.length > 0) {
      console.error("✗ 标签体系门禁未通过：");
      for (const error of errors) console.error(`  - ${error}`);
      console.error("");
      console.error(`清单：${LABELS_FILE}；模板：${TEMPLATE_DIR}/*.md`);
      process.exit(1);
    }
    console.log(`✓ 标签体系一致（${labels.length} 个标签，${templates.length} 个模板）`);
    process.exit(0);
  }

  // 同步模式：先跑校验，避免把非法清单推到仓库。
  const errors = validateLabels(labels, templates);
  if (errors.length > 0) {
    console.error("✗ 清单自身不合规，已中止同步：");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  for (const { name, color, description } of labels) {
    execFileSync("gh", ["label", "create", name, "--color", color, "--description", description, "--force"], {
      stdio: "inherit",
    });
  }
  console.log(`✓ 已同步 ${labels.length} 个标签到仓库`);
}
