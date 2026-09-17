#!/usr/bin/env node
/**
 * issue 自动分类器：把模板里的人工勾选翻译成机器可筛选的标签。
 *
 * 输入（环境变量，由 .github/workflows/issue-triage.yml 注入）：
 *   ISSUE_TITLE   议题标题
 *   ISSUE_BODY    议题正文
 *   ISSUE_LABELS  议题已有标签（逗号分隔）
 *
 * 输出（stdout）：待添加的标签，**每行一个**（无则输出空行）。workflow 侧逐行
 * `gh issue edit --add-label`。行分隔而非空格/逗号分隔是刻意的：标签名合法地包含空格
 * （`status: triage`、`good first issue`），任何以空格为分隔符的传输都会把它拆成两个
 * 不存在的标签——2026-09-14 实际发生过（workflow 侧 `tr ' ' ','` → `'status:' not found`）。
 *
 * 分类规则（只做"能机械判定"的部分，语义分诊仍由人做）：
 *   1. 作用域——解析正文「影响 scope」节中已勾选的项，映射为 `scope:*`。
 *      只认 `.github/labels.yml` 里声明过的 scope（白名单），避免把正文其它
 *      复选框（如「契约影响」节）误判成作用域。
 *   2. 严重级——解析正文「严重级」节中已勾选的项，映射为 `priority: pN`（#406）。
 *      取值与 `docs/technical-debt/README.md` §严重级定义同源，同样走白名单过滤；
 *      **多选时取最严重的一档**（定级宁可保守，且输出是正文的确定函数）。
 *   3. 状态——议题当前没有任何 `status:*` 标签时补 `status: triage`，使新议题
 *      默认落在"待分诊"队列；人把它推进到 in-progress 后，本步骤不再插手。
 *
 * 注意：本脚本**只增不减**。自动分类若误判，人工摘掉标签即可，脚本不会再加回
 * （`status:` 例外：全摘光会被重新补 triage，这是刻意的——空白状态回到待分诊）。
 * 但 `scope:*` 与「严重级」推出的 `priority:*` 是**正文的投影**：只摘标签而不取消
 * 勾选，下一次编辑（`edited` 事件）会被重新打上——撤销的正确动作是取消勾选 + 摘标签，
 * 见 `docs/issue-management.md` §5。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { extractSection, normalizeScopeOption, normalizeSeverityOption } from "./sync-labels.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABELS_FILE = ".github/labels.yml";

/** 新议题的默认状态标签。 */
const DEFAULT_STATUS = "status: triage";

/**
 * 读取清单中某个前缀的取值白名单。
 *
 * 两种命名风格都要认：`scope:ui`（前缀后紧接取值）与 `priority: p0`（带一个空格，
 * 与 `status: triage` 同风格）——只按 `startsWith("scope:")` 那样写会漏掉后者。
 * @param {string} root 仓库根目录
 * @param {string} prefix 前缀（不含冒号），如 `scope` / `priority`
 * @returns {Set<string>} 取值集合（如 `ui` / `p0`）
 */
export function loadLabelValues(root, prefix) {
  const parsed = parseYaml(readFileSync(join(root, LABELS_FILE), "utf8"));
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  const pattern = new RegExp(`^${prefix}[:：]\\s*`);
  return new Set(
    labels
      .map(label => label?.name)
      .filter(name => typeof name === "string" && pattern.test(name))
      .map(name => name.replace(pattern, "")),
  );
}

/**
 * 读取清单中声明的作用域白名单。
 * @param {string} root 仓库根目录
 * @returns {Set<string>} 不含 `scope:` 前缀的作用域名
 */
export function loadAllowedScopes(root) {
  return loadLabelValues(root, "scope");
}

/**
 * 读取清单中声明的优先级白名单（`priority: p0` … `p3`）。
 * @param {string} root 仓库根目录
 * @returns {Set<string>} 不含 `priority:` 前缀的取值（`p0`–`p3`）
 */
export function loadAllowedPriorities(root) {
  return loadLabelValues(root, "priority");
}

/**
 * 读取正文某个勾选节中已勾选项归一化后的取值。
 *
 * **不越界**：只在 `## <title>` 到下一个二级标题之间扫，因此正文别处的复选框
 * （如「契约影响」节的四项）不会被算进来。
 * @param {string} body 议题正文
 * @param {string} title 二级标题文本（如 `影响 scope`）
 * @param {(text: string) => string|null} normalize 勾选项文本 → 取值
 * @returns {string[]} 取值列表（保持正文顺序，可含重复，由调用方决定去重语义）
 */
function readCheckedValues(body, title, normalize) {
  const section = extractSection(body ?? "", title);
  if (section === null) return [];
  const values = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*-\s*\[[xX]\]\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const value = normalize(match[1]);
    if (value !== null) values.push(value);
  }
  return values;
}

/**
 * 推导某个 issue 应当补打的标签。
 * @param {{body?: string, existingLabels?: string[], allowedScopes: Set<string>, allowedPriorities?: Set<string>}} input 输入
 * @returns {string[]} 待添加标签（作用域按正文顺序、严重级其次、状态在末尾；均已排除已有标签）
 */
export function classifyIssue({ body, existingLabels = [], allowedScopes, allowedPriorities = new Set() }) {
  const existing = new Set(existingLabels);
  const add = [];
  const push = label => {
    if (!existing.has(label) && !add.includes(label)) add.push(label);
  };

  // ① 作用域：一个议题可影响多个模块，故逐个映射（多选是常态）。
  for (const scope of readCheckedValues(body, "影响 scope", normalizeScopeOption)) {
    if (allowedScopes.has(scope)) push(`scope:${scope}`);
  }

  // ② 严重级：同一维度**至多一个**标签（§1），故先做存在性检查——已有 `priority:*`
  //    时一律不动（分诊结论优先于模板勾选）；再对单选/多选求值：多选取最严重的一档。
  //    `p0`–`p3` 同位数，字典序即严重度序（升序第一项 = 最严重）。
  const hasPriority = [...existing].some(label => label.startsWith("priority:"));
  if (!hasPriority) {
    const severities = readCheckedValues(body, "严重级", normalizeSeverityOption).filter(value =>
      allowedPriorities.has(value),
    );
    if (severities.length > 0) {
      push(`priority: ${[...severities].sort()[0]}`);
    }
  }

  if (![...existing].some(label => label.startsWith("status:"))) {
    add.push(DEFAULT_STATUS);
  }

  return add;
}

// 仅当直接以脚本运行时执行 CLI 逻辑；被 import 时不触发副作用。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let allowedScopes;
  let allowedPriorities;
  try {
    allowedScopes = loadAllowedScopes(ROOT);
    allowedPriorities = loadAllowedPriorities(ROOT);
  } catch (error) {
    console.error(`✗ 读取标签清单失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const existingLabels = (process.env.ISSUE_LABELS ?? "")
    .split(",")
    .map(label => label.trim())
    .filter(Boolean);

  const labels = classifyIssue({
    body: process.env.ISSUE_BODY,
    existingLabels,
    allowedScopes,
    allowedPriorities,
  });

  if (labels.length > 0) {
    console.log(labels.join("\n"));
    if (process.env.ISSUE_TITLE) {
      console.error(`→ ${process.env.ISSUE_TITLE}：新增 ${labels.join("、")}`);
    }
  }
}
