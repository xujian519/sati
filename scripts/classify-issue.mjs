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
 *   2. 状态——议题当前没有任何 `status:*` 标签时补 `status: triage`，使新议题
 *      默认落在"待分诊"队列；人把它推进到 in-progress 后，本步骤不再插手。
 *
 * 注意：本脚本**只增不减**。自动分类若误判，人工摘掉标签即可，脚本不会再加回
 * （`status:` 例外：全摘光会被重新补 triage，这是刻意的——空白状态回到待分诊）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { extractSection, normalizeScopeOption } from "./sync-labels.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABELS_FILE = ".github/labels.yml";

/** 新议题的默认状态标签。 */
const DEFAULT_STATUS = "status: triage";

/**
 * 读取清单中声明的作用域白名单。
 * @param {string} root 仓库根目录
 * @returns {Set<string>} 不含 `scope:` 前缀的作用域名
 */
export function loadAllowedScopes(root) {
  const parsed = parseYaml(readFileSync(join(root, LABELS_FILE), "utf8"));
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  return new Set(
    labels
      .map(label => label?.name)
      .filter(name => typeof name === "string" && name.startsWith("scope:"))
      .map(name => name.slice("scope:".length)),
  );
}

/**
 * 推导某个 issue 应当补打的标签。
 * @param {{body?: string, existingLabels?: string[], allowedScopes: Set<string>}} input 输入
 * @returns {string[]} 待添加标签（已按正文顺序 + 状态在末尾；均已排除已有标签）
 */
export function classifyIssue({ body, existingLabels = [], allowedScopes }) {
  const existing = new Set(existingLabels);
  const add = [];

  const section = extractSection(body ?? "", "影响 scope");
  if (section !== null) {
    for (const line of section.split(/\r?\n/)) {
      const match = /^\s*-\s*\[[xX]\]\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const scope = normalizeScopeOption(match[1]);
      if (scope === null || !allowedScopes.has(scope)) continue;
      const label = `scope:${scope}`;
      if (!existing.has(label) && !add.includes(label)) add.push(label);
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
  try {
    allowedScopes = loadAllowedScopes(ROOT);
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
  });

  if (labels.length > 0) {
    console.log(labels.join("\n"));
    if (process.env.ISSUE_TITLE) {
      console.error(`→ ${process.env.ISSUE_TITLE}：新增 ${labels.join("、")}`);
    }
  }
}
