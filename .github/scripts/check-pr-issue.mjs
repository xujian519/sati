#!/usr/bin/env node
/**
 * PR 可追溯性门禁：强制 pull request 能回溯到一个需求来源。
 *
 * 输入：环境变量 PR_TITLE、PR_BODY（由 .github/workflows/ci.yml 注入，值为
 * `github.event.pull_request.title/.body`）。不在 pull_request 事件上时本 job
 * 不会运行（workflow 侧用 `if: github.event_name == 'pull_request'` 限制）。
 *
 * 通过条件（任一命中即通过）：
 *   1. 关联写法：PR 标题/描述中出现 `Closes #123`、`Fixes #123`、
 *      `关联 Issue: #123` 等「关键词 + 编号」。
 *   2. 裸引用写法：出现 `#123`（GitHub 会自动转为 issue/PR 链接）。
 *   3. 技术债编号：出现 `TD-PATENT-N06` 等债编号（项目以
 *      docs/technical-debt/backlog.md 登记并以此作为可回溯来源）。
 *   4. 显式豁免：出现「无关联 issue」/「No issue」/「skip-issue-check」等标记。
 *
 * 失败：退出码非 0，使 CI job 失败，并打印如何修复的指引。
 *
 * 说明：第 2 条是宽松策略，用于不苛求 PR 必须写明 `Closes` 字样；如过宽可删除
 * `BARE_NUMBER` 判定，此时第 1 条的关键词分支已能覆盖模板原生「关联 Issue: #N」。
 */

import { pathToFileURL } from "node:url";

// 1. 关键词 + 编号：`Closes #123` / `关联 Issue: #123` 等。
//    允许关键词与编号之间出现可选的 `Issue:` 字样，以匹配 PR 模板的原生写法。
const LINK_KEYWORD =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|关联|解决|修复|关闭)\s*(?:issue\s*:?)?\s*#?\s*[0-9]+/i;
// 2. 裸 issue/PR 引用：`#123`
const BARE_NUMBER = /#\s*[0-9]+\b/;
// 3. 技术债编号：`TD-PATENT-N06` / `TD-ADAPTERS-N01`
const TECH_DEBT = /\bTD-[A-Z][A-Z0-9-]*\d\b/i;
// 4. 显式豁免标记
const EXEMPT = /(无关联\s*issue|no\s+issue|skip-issue-check|n\/a)/i;

/**
 * 判断 PR 标题/描述是否满足可回溯门禁。
 * @param {string|undefined} title PR 标题
 * @param {string|undefined} body PR 描述
 * @returns {{ pass: boolean, path: "issue-link"|"bare-number"|"tech-debt"|"exempt"|null }}
 */
export function evaluatePrTraceability(title, body) {
  const text = `${title ?? ""}\n${body ?? ""}`;
  if (LINK_KEYWORD.test(text)) return { pass: true, path: "issue-link" };
  if (BARE_NUMBER.test(text)) return { pass: true, path: "bare-number" };
  if (TECH_DEBT.test(text)) return { pass: true, path: "tech-debt" };
  if (EXEMPT.test(text)) return { pass: true, path: "exempt" };
  return { pass: false, path: null };
}

// 仅当直接以脚本运行时执行 CLI 逻辑；被 import 时不触发 process.exit。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { pass, path } = evaluatePrTraceability(process.env.PR_TITLE, process.env.PR_BODY);

  if (pass) {
    const label = {
      "issue-link": "检测到 issue 引用",
      "bare-number": "检测到 # 引用",
      "tech-debt": "检测到技术债编号（TD-*）",
      exempt: "已显式声明「无关联 issue」",
    }[path];
    console.log(`✓ PR 已通过可追溯门禁（${label}）`);
    process.exit(0);
  }

  console.error("✗ 本 PR 未关联任何 issue/技术债，无法回溯到需求来源。");
  console.error("");
  console.error("修复方式（任选其一）：");
  console.error("  1. 关联 issue：在 PR 描述中写明，例如「Closes #123」或「关联 Issue: #123」；");
  console.error(
    "  2. 偿还技术债：在 PR 描述中写明债编号，例如「TD-PATENT-N06」（见 docs/technical-debt/backlog.md）；",
  );
  console.error("  3. 显式豁免：如确无对应来源，请在 PR 描述中声明「无关联 issue」。");
  process.exit(1);
}
