#!/usr/bin/env node
/**
 * PR 可追溯性门禁：强制 pull request 能回溯到一个远端 issue。
 *
 * 输入：环境变量 PR_TITLE、PR_BODY（由 .github/workflows/ci.yml 注入，值为
 * `github.event.pull_request.title/.body`）。不在 pull_request 事件上时本 job
 * 不会运行（workflow 侧用 `if: github.event_name == 'pull_request'` 限制）。
 *
 * 通过条件（任一命中即通过）：
 *   1. 关联写法：PR 标题/描述中出现 `Closes #123`、`Fixes #123`、
 *      `关联 Issue: #123` 等「关键词 + 编号」。
 *   2. 裸引用写法：出现 `#123`（GitHub 会自动转为 issue/PR 链接）。
 *   3. 显式豁免：出现「无关联 issue」/「No issue」/「skip-issue-check」等标记。
 *
 * 失败：退出码非 0，使 CI job 失败，并打印如何修复的指引。
 *
 * 说明：第 2 条是宽松策略，用于不苛求 PR 必须写明 `Closes` 字样；如过宽
 * 可删除 `BARE_NUMBER` 判定，仅保留关键词 + 豁免两种途径。
 */

const title = process.env.PR_TITLE ?? "";
const body = process.env.PR_BODY ?? "";
const text = `${title}\n${body}`;

// 1. 关键词 + 编号：`Closes #123` / `关联 Issue: #123` 等
const LINK_KEYWORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|关联|解决|修复|关闭)\s*#?\s*[0-9]+/i;
// 2. 裸 issue/PR 引用：`#123`
const BARE_NUMBER = /#\s*[0-9]+\b/;
// 3. 显式豁免标记
const EXEMPT = /(无关联\s*issue|no\s+issue|skip-issue-check|n\/a)/i;

if (LINK_KEYWORD.test(text) || BARE_NUMBER.test(text)) {
  console.log("✓ PR 已关联 issue（检测到 issue 引用）");
  process.exit(0);
}

if (EXEMPT.test(text)) {
  console.log("✓ PR 已显式声明「无关联 issue」，本次跳过门禁");
  process.exit(0);
}

console.error("✗ 本 PR 未关联任何 issue，无法回溯到需求来源。");
console.error("");
console.error("修复方式（任选其一）：");
console.error("  1. 关联 issue：在 PR 描述中写明，例如「Closes #123」或「关联 Issue: #123」；");
console.error("  2. 显式豁免：如确无对应 issue，请在 PR 描述中声明「无关联 issue」。");
process.exit(1);
