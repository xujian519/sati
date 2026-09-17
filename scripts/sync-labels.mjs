#!/usr/bin/env node
/**
 * 标签体系门禁与同步器。
 *
 * `.github/labels.yml` 是标签体系的单一事实源，本脚本负责两件事：
 *
 *   node scripts/sync-labels.mjs           # 同步：把清单 upsert 到仓库（幂等，需 gh 已登录）
 *   node scripts/sync-labels.mjs --check   # 门禁：校验清单与 issue 模板一致（挂 pnpm lint）
 *
 * `--check` 拦截五类漂移：
 *   1. 清单自身不合规——标签名重复/为空，color 非 6 位 hex，description 为空或超长（GitHub 上限 100）。
 *   2. 模板引用了未声明的标签——`.github/ISSUE_TEMPLATE/*.md` frontmatter 的 `labels:` 必须在清单中。
 *   3. 模板的「影响 scope」勾选项与 `scope:*` 标签集合不一致（双向：模板多出/标签多出都拦）。
 *   4. 带前缀标签（`status:` / `priority:` / `scope:`）缺取值；`status:` / `priority:`
 *      取值超出词表（`scope:` 的取值由第 3 条双向校验兜底，故不在此另立词表）。
 *   5. 多条模板的「影响 scope」勾选项彼此不一致——GitHub 的 issue 模板无法共享片段，
 *      同一份清单在每条模板里各抄一遍；只改其中一条时，第 3 条校验仍会通过（因为校验的是
 *      模板**并集**），缺口只能在这里拦。
 *
 * 第 3、5 条是这套门禁的核心价值：issue 模板里的 scope 复选框会被
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
 * 带枚举取值的标签前缀及其合法取值。
 *
 * 定义同源：`docs/issue-management.md` §1——状态机（终态由**关闭**表达，故刻意无 `done`）
 * 与优先级表（`p0`–`p3`，含义沿用 `docs/technical-debt/README.md` §严重级定义）。
 * `scope:` 不在表内：它的取值集合随 issue 模板变化，且已有双向校验（模板勾选项 ↔ `scope:*`）
 * 兜底——在此再抄一份就成了第四份词表。
 */
const PREFIX_VALUES = {
  status: ["triage", "in-progress", "blocked"],
  priority: ["p0", "p1", "p2", "p3"],
};

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
 * 把模板「严重级」勾选项归一化为 `priority:` 取值。
 *
 * 取值与 `docs/technical-debt/README.md` §严重级定义同源（`P0 堵塞` … `P3 低`），
 * 只认级别前缀——选项后半的含义/处置文本可以改措辞，级别本身不能改。
 *
 * **认不出时原样返回（小写化）而不是丢弃**：`P4`、`紧急` 这类写错的选项若被静默丢掉，
 * 就成了「模板写了但没人管」的盲区（门禁看不见、分类器也不产出，与「缺整节」同型）。
 * 原样返回后，门禁会把它报成「模板勾选项「p4 未知」没有对应的 priority: p4 未知 标签声明」，
 * 而分类器侧由白名单过滤兜底——两侧都不静默。
 * @param {string} text 勾选项文本（可能带 HTML 注释与说明）
 * @returns {string|null} `p0`–`p3`；认不出则返回清理后的原文；空则 null
 */
export function normalizeSeverityOption(text) {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!cleaned) return null;
  const match = /^[Pp]([0-3])(?![0-9])/.exec(cleaned);
  return match === null ? cleaned.toLowerCase() : `p${match[1]}`;
}

/**
 * 提取模板「严重级」节的勾选项。
 * @param {string} markdown 模板全文
 * @returns {string[]} `p0`–`p3` 列表（保持模板顺序，去重）
 */
export function parseSeverityOptions(markdown) {
  const section = extractSection(markdown, "严重级");
  if (section === null) return [];
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*-\s*\[[ xX]\]\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const value = normalizeSeverityOption(match[1]);
    if (value !== null && !out.includes(value)) out.push(value);
  }
  return out;
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
 * 读取全部 issue 模板（frontmatter labels + 「影响 scope」/「严重级」勾选项）。
 * @param {string} root 仓库根目录
 * @returns {Array<{file: string, labels: string[], scopes: string[], severities: string[]}>}
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
      return { file, labels, scopes: parseScopeOptions(markdown), severities: parseSeverityOptions(markdown) };
    });
}

/**
 * 参与「模板 ↔ 标签取值」双向校验的枚举节。
 *
 * 每一节都要回答同一个问题：模板里的勾选项与 `.github/labels.yml` 的带前缀标签是否
 * **同一份取值**。差异只在该节叫什么、映射到哪个标签名、以及勾选项文本怎么归一化——
 * 故用一张表驱动，而不是把同一段校验抄两遍（抄两遍就会像「契约影响」节那样各自漂移）。
 *
 * ⚠️ 标签名**不都是「前缀 + 取值」**：`scope:` 是 `scope:ui`，而 `priority:` 是
 * `priority: p0`（带一个空格，与 `status: triage` 同风格）。所以每节自带 `labelOf()`
 * 与 `declared()`，不能假设统一的分隔符——这正是「照着 scope 抄一份」会踩的坑。
 */
const ENUM_SECTIONS = [
  {
    title: "影响 scope",
    field: "scopes",
    labelOf: value => `scope:${value}`,
    declared: labels =>
      labels
        .map(label => label?.name)
        .filter(name => typeof name === "string" && name.startsWith("scope:"))
        .map(name => name.slice("scope:".length)),
  },
  {
    title: "严重级",
    field: "severities",
    labelOf: value => `priority: ${value}`,
    declared: labels =>
      labels
        .map(label => label?.name)
        .filter(name => typeof name === "string" && /^priority:\s*/.test(name))
        .map(name => name.replace(/^priority:\s*/, "")),
  },
];

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
    if (prefix) {
      const value = name.slice(prefix[0].length).trim();
      const allowed = PREFIX_VALUES[prefix[1]];
      if (value === "") {
        errors.push(`标签 ${name} 的前缀 ${prefix[0]} 后缺取值`);
      } else if (allowed && !allowed.includes(value)) {
        errors.push(`标签 ${name} 的取值超出词表（${prefix[1]}: 仅允许 ${allowed.join(" / ")}）`);
      }
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

  // 枚举节：模板勾选项 ↔ 带前缀标签，双向一致（当前两节：「影响 scope」→ `scope:*`、
  // 「严重级」→ `priority: *`）。两节的差异只有节名/标签名构造/归一化，故共用同一段校验。
  for (const section of ENUM_SECTIONS) {
    const declared = new Set(section.declared(labels));
    const fromTemplates = new Set(templates.flatMap(template => template[section.field] ?? []));
    for (const value of fromTemplates) {
      if (!declared.has(value)) {
        errors.push(`模板勾选项「${value}」没有对应的 ${section.labelOf(value)} 标签声明`);
      }
    }
    for (const value of declared) {
      if (!fromTemplates.has(value)) {
        errors.push(`标签 ${section.labelOf(value)} 在 issue 模板的「${section.title}」节中没有对应勾选项`);
      }
    }
  }

  // 模板之间的一致性。上面两条校验看的是模板**并集**，因此「只改了其中一条模板」不会
  // 被它们发现——而 GitHub 的 issue 模板无法共享片段，同一份勾选清单必然在每条模板里
  // 各存一份。这里以**排序后的第一条**含该节的模板为基准逐条比对。
  // 不含该节的模板不参与：它本来就不产生对应的标签。2026-09-17 前 `tech_debt.md` 是
  // 「影响 scope」节唯一此类模板（TD-PROCGATE-003），补节后全部模板参与比对（2026-09-18
  // 新增的 `documentation.md` 一落地即带该节，其参与方式经负控制实测：删一行勾选项被本条
  // 拦下、加一行未声明选项被上一条拦下）——这条过滤仍留给下一个新增模板，它未必一落地就带该节。
  // 「严重级」节目前只有 `tech_debt.md` 一条模板有（#406）：跨模板比对在此为 no-op，
  // 但规则先就位——第二个带该节的模板一出现即自动纳管，不必再改门禁。
  for (const section of ENUM_SECTIONS) {
    const withSection = templates.filter(template => (template[section.field] ?? []).length > 0);
    if (withSection.length < 2) continue;
    const [reference, ...others] = withSection;
    const referenceValues = new Set(reference[section.field]);
    for (const template of others) {
      const currentValues = new Set(template[section.field]);
      for (const value of referenceValues) {
        if (!currentValues.has(value)) {
          errors.push(
            `${TEMPLATE_DIR}/${template.file} 的「${section.title}」节缺勾选项「${value}」（与 ${reference.file} 不一致）`,
          );
        }
      }
      for (const value of currentValues) {
        if (!referenceValues.has(value)) {
          errors.push(
            `${TEMPLATE_DIR}/${template.file} 的「${section.title}」节多出勾选项「${value}」（与 ${reference.file} 不一致）`,
          );
        }
      }
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
