#!/usr/bin/env node
/**
 * open-pr.mjs — 一键开 PR（封装「检查/创建 issue → 组装 body → gh pr create」）。
 *
 * 解决的结构性问题：
 *   1. 时序倒挂：先建 issue 再开 PR，body 首次即带 `Closes #n`，CI 的
 *      pr-traceability 门禁（.github/scripts/check-pr-issue.mjs）不再第一次失败。
 *   2. 无封装入口：一条命令完成 title 推导 / issue 检查 / PR 创建，杜绝手拼 body 遗漏关联。
 *
 * 用法：
 *   node scripts/open-pr.mjs                  # 自动推导 title，检查既有 issue / 无则创建
 *   node scripts/open-pr.mjs --issue 123      # 复用指定 issue
 *   node scripts/open-pr.mjs --no-issue       # 显式豁免（body 带「无关联 issue」）
 *   node scripts/open-pr.mjs --title "..."    # 覆盖自动推导的 title
 *   node scripts/open-pr.mjs --base main      # 指定 base 分支（默认 main）
 *   node scripts/open-pr.mjs --dry-run        # 只打印将执行的命令，不实际执行
 *
 * 退出码：0 成功（含「已存在 PR」短路）；1 失败。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TYPE_PREFIXES = new Set([
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "style",
  "perf",
  "ci",
  "build",
  "revert",
  "release",
]);
const DEFAULT_BASE = "main";

/** 项目实际使用的 Conventional Commits scope（CLAUDE.md 建议 + git 历史高频项）。 */
const KNOWN_SCOPES = new Set([
  "agent",
  "ui",
  "gateway",
  "memory",
  "router",
  "cli",
  "mcp",
  "always-on",
  "tool",
  "knowledge",
  "patent",
  "model",
  "literature",
  "cron",
  "rule",
  "desktop",
  "team",
  "extension",
  "session",
  "workflow",
  "web",
]);

/**
 * 从分支名推导 Conventional Commits 标题。
 * 规则：`<type>/<rest>`；rest 的首段（到第一个 `-`/`/` 止）若命中 KNOWN_SCOPES
 * 则作 scope，其余部分把 `-`/`/` 转空格作 subject。
 *   分支名                              → 标题
 *   feat/cron-agentic-automation       → feat(cron): agentic automation
 *   feat/patent-figuregen              → feat(patent): figuregen
 *   fix/claim-chart-gap                → fix: claim chart gap（claim 不在 scope 词表）
 *   docs/readme                        → docs: readme
 *   release/v0.1.9                     → release: v0.1.9
 * 非标准 type 前缀返回空串（调用方应提示用 --title 指定）。
 */
export function deriveTitleFromBranch(branch) {
  if (!branch) return "";
  const [type, ...restSegs] = branch.split("/");
  const rest = restSegs.join("/");
  if (!TYPE_PREFIXES.has(type)) return "";
  const normalized = rest.replace(/[-/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return `${type}: untitled`;
  const firstSegment = rest.split("/")[0]?.split("-")[0] ?? "";
  if (KNOWN_SCOPES.has(firstSegment)) {
    const subject = rest
      .slice(firstSegment.length)
      .replace(/^[-/]+/, "")
      .replace(/[-/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (subject) return `${type}(${firstSegment}): ${subject}`;
  }
  return `${type}: ${normalized}`;
}

/**
 * 组装 PR body（含 pr-traceability 门禁可识别的关联段）。
 * @param {string[]} commits commit 摘要行
 * @param {number|undefined|null} issueNumber
 *   number=关联 issue；undefined=脚本将自动创建 issue（dry-run 占位）；
 *   null=显式豁免（写「无关联 issue」）。
 */
export function formatPrBody(commits, issueNumber) {
  const changeList =
    commits.length > 0 ? commits.map(commit => `- ${commit}`).join("\n") : "- 本次变更无独立 commit 摘要（请补充描述）";
  let trace;
  if (issueNumber === undefined) {
    trace = "Closes #<脚本将自动创建 issue>";
  } else if (issueNumber == null) {
    trace = "无关联 issue";
  } else {
    trace = `Closes #${issueNumber}`;
  }
  return [
    "## 描述",
    "",
    "<!-- 简要描述本 PR 的变更内容与动机。 -->",
    "",
    trace,
    "",
    "## 变更内容",
    "",
    changeList,
    "",
    "## 测试",
    "",
    "- [ ] 本地 `pnpm test` 通过",
    "- [ ] `pnpm lint` 与 `pnpm format:check` 通过",
    "- [ ] `pnpm typecheck` 通过",
    "",
  ].join("\n");
}

/**
 * 从分支名提取 issue 搜索关键词（去 `-`，过滤 <3 字符的短词，最多 3 个）。
 *   feat/cron-agentic-automation → ["cron", "agentic", "automation"]
 */
export function issueSearchKeywordsFromBranch(branch) {
  const rest = branch.split("/").slice(1).join("/").replaceAll("-", " ").replace(/\s+/g, " ").trim();
  return rest
    .split(" ")
    .filter(word => word.length >= 3)
    .slice(0, 3);
}

function parseArgs(argv) {
  const opts = { issue: undefined, noIssue: false, base: DEFAULT_BASE, title: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--issue":
        opts.issue = Number(argv[++i]);
        break;
      case "--no-issue":
        opts.noIssue = true;
        break;
      case "--base":
        opts.base = argv[++i];
        break;
      case "--title":
        opts.title = argv[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (opts.issue != null && Number.isNaN(opts.issue)) throw new Error("--issue 需要整数参数");
  if (opts.noIssue && opts.issue != null) throw new Error("--issue 与 --no-issue 互斥");
  return opts;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? "";
    throw new Error(`${cmd} ${args.join(" ")} 失败：${stderr || error.message}`);
  }
}

function git(args) {
  return run("git", args);
}

function gh(args) {
  return run("gh", args);
}

/** 查找既有 open issue（按关键词搜索 title）；找不到则创建一个。dry-run 只打印命令。 */
function findOrCreateIssue(branch, title, dryRun) {
  const keywords = issueSearchKeywordsFromBranch(branch);
  if (keywords.length > 0) {
    const query = keywords.map(word => `${word} in:title`).join(" ");
    const list = gh(["issue", "list", "--search", query, "--state", "open", "--json", "number,title", "--limit", "5"]);
    if (list && list !== "[]") {
      const issues = JSON.parse(list);
      if (issues.length > 0) {
        const first = issues[0];
        console.log(`✓ 复用既有 issue #${first.number}：${first.title}`);
        return first.number;
      }
    }
  }
  const body =
    "## 背景\n\n<!-- 简述需求来源与动机。 -->\n\n## 验收标准\n\n- [ ] 功能实现\n- [ ] 单元测试\n- [ ] 文档更新（如需）\n";
  if (dryRun) {
    console.log(`[dry-run] gh issue create --title "${title}" --body-file <临时文件>`);
    return undefined;
  }
  const tmp = mkdtempSync(join(tmpdir(), "sati-issue-"));
  try {
    const bodyFile = join(tmp, "issue.md");
    writeFileSync(bodyFile, body, "utf8");
    const created = gh(["issue", "create", "--title", title, "--body-file", bodyFile]);
    // gh 输出为纯 URL（如 https://github.com/xujian519/sati/issues/216），不带 `#N` 形式。
    const match = created.match(/(?:issues|pull)\/([0-9]+)/);
    const number = match ? Number(match[1]) : null;
    if (number == null) {
      console.error(`⚠ 无法从 gh issue create 输出解析 issue 编号：${created}`);
      return null;
    }
    console.log(`✓ 已创建 issue #${number}`);
    return number;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const branch = git(["branch", "--show-current"]);
    if (!branch) throw new Error("当前不在任何分支上，请先 checkout 功能分支");
    if (branch === opts.base) throw new Error(`当前分支是 ${opts.base}，请在功能分支上开 PR`);
    git(["rev-parse", "--verify", "--quiet", opts.base]);

    // 已有 PR 短路：同一 head 分支已有 open PR 则直接返回，避免重复创建。
    const existing = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"]);
    if (existing && existing !== "[]") {
      const pr = JSON.parse(existing)[0];
      console.log(`✓ 分支 ${branch} 已存在 PR #${pr.number}: ${pr.url}`);
      return;
    }

    const title = opts.title ?? deriveTitleFromBranch(branch);
    if (!title) throw new Error(`无法从分支名 ${branch} 推导标题，请用 --title 指定`);

    let issueNumber = opts.issue;
    if (opts.noIssue) {
      issueNumber = null;
    } else if (issueNumber == null) {
      issueNumber = findOrCreateIssue(branch, title, opts.dryRun);
    }

    const commits = git(["log", `${opts.base}..HEAD`, "--oneline", "--no-decorate"])
      .split("\n")
      .filter(Boolean);
    const body = formatPrBody(commits, issueNumber);

    if (opts.dryRun) {
      console.log(`[dry-run] gh pr create --base ${opts.base} --title "${title}" --body-file <临时文件>`);
      console.log("--- PR body ---");
      console.log(body);
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), "sati-pr-"));
    try {
      const bodyFile = join(tmp, "body.md");
      writeFileSync(bodyFile, body, "utf8");
      const url = gh(["pr", "create", "--base", opts.base, "--title", title, "--body-file", bodyFile]);
      console.log(`✓ PR 已创建：${url}`);
      console.log(
        `  关联 ${issueNumber != null ? `issue #${issueNumber}（Closes #${issueNumber}）` : "（无关联 issue）"}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
