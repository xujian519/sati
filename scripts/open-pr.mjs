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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABELS_FILE = ".github/labels.yml";

/** 标签侧独有的取值：它是「未列入上述模块的其他作用域」的兜底，不可能出现在提交 scope 里。 */
export const LABEL_ONLY_SCOPE = "other";

/**
 * 提交侧独有的 scope——它们是提交历史的真实取值，但**不属于** issue 面的 `scope:*` 标签：
 * issue 面只收「用户可感知的独立模块」（判据见 `docs/issue-management.md` §1），提交面
 * 允许更细的切分。
 *
 * 本表与 `.github/labels.yml` 的 `scope:*` **不得重叠**：某个 scope 一旦被提升为标签，
 * 就必须从本表删除（判定见 `duplicateScopeDeclarations()`，由 `open-pr.test.mjs` 拦）。
 */
export const COMMIT_ONLY_SCOPES = new Set(["team", "extension", "session", "workflow", "web"]);

/**
 * 读取 `.github/labels.yml` 声明的作用域取值（含 `LABEL_ONLY_SCOPE`）。
 * @param {string} root 仓库根目录
 * @returns {Set<string>} 不含 `scope:` 前缀的作用域名
 */
export function loadLabelScopes(root) {
  const parsed = parseYaml(readFileSync(join(root, LABELS_FILE), "utf8"));
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  return new Set(
    labels
      .map(label => (typeof label?.name === "string" ? label.name : ""))
      .filter(name => name.startsWith("scope:"))
      .map(name => name.slice("scope:".length)),
  );
}

/**
 * 派生提交 scope 词表 = `labels.yml` 的 `scope:*`（剔除 `LABEL_ONLY_SCOPE`）∪ `COMMIT_ONLY_SCOPES`。
 *
 * 之所以**派生**而不是手抄：清单已是标签体系的单一事实源，再抄一份就是第三份词表——
 * 改一处、静默失效。`docs/notes/implemented/2026-09-14-issue-management.md` 已明确
 * 否决「把标签直接硬编码在脚本里」，本函数即为兑现该结论。
 *
 * 之所以剔除 `other`：分支 `feat/other-x` 若把 `other` 当 scope，会产出
 * `feat(other): x`——一个不表达任何模块的 scope。
 * @param {string} root 仓库根目录
 * @returns {Set<string>} 提交 scope 词表
 */
export function loadKnownScopes(root) {
  const derived = [...loadLabelScopes(root)].filter(scope => scope !== LABEL_ONLY_SCOPE);
  return new Set([...derived, ...COMMIT_ONLY_SCOPES]);
}

/**
 * 找出被同时声明为「标签作用域」与「提交独有作用域」的项。正常应为空数组；
 * 非空说明有人把某个 scope 提升成了 `scope:*` 标签，却忘了删本表的旧声明。
 * @param {string} root 仓库根目录
 * @returns {string[]} 重叠项（已排序，便于断言）
 */
export function duplicateScopeDeclarations(root) {
  const labelScopes = loadLabelScopes(root);
  return [...COMMIT_ONLY_SCOPES].filter(scope => labelScopes.has(scope)).sort();
}

let knownScopesCache;

/**
 * 惰性派生并缓存提交 scope 词表。惰性是为了保持「被 import 时不触碰文件系统」这一
 * 仓内约定（同 `classify-issue.mjs`）：只有真正要推导标题时才读清单。
 * @returns {Set<string>} 提交 scope 词表
 */
export function knownScopes() {
  knownScopesCache ??= loadKnownScopes(ROOT);
  return knownScopesCache;
}

/**
 * 从分支名推导 Conventional Commits 标题。
 * 规则：`<type>/<rest>`；rest 的首段（到第一个 `-`/`/` 止）若命中 scope 词表
 * 则作 scope，其余部分把 `-`/`/` 转空格作 subject。
 *   分支名                              → 标题
 *   feat/cron-agentic-automation       → feat(cron): agentic automation
 *   feat/patent-figuregen              → feat(patent): figuregen
 *   fix/claim-chart-gap                → fix: claim chart gap（claim 不在 scope 词表）
 *   docs/readme                        → docs: readme
 *   release/v0.1.9                     → release: v0.1.9
 * 非标准 type 前缀返回空串（调用方应提示用 --title 指定）。
 *
 * scope 词表默认由 `labels.yml` 派生（见 `knownScopes()`），显式传入可绕过文件系统
 * 依赖——纯逻辑用例走这条路径。
 * @param {string} branch 当前分支名
 * @param {Set<string>} [scopes] scope 词表，默认从标签清单派生
 * @returns {string} Conventional Commits 标题（无法推导时为空串）
 */
export function deriveTitleFromBranch(branch, scopes = knownScopes()) {
  if (!branch) return "";
  const [type, ...restSegs] = branch.split("/");
  const rest = restSegs.join("/");
  if (!TYPE_PREFIXES.has(type)) return "";
  const normalized = rest.replace(/[-/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return `${type}: untitled`;
  const firstSegment = rest.split("/")[0]?.split("-")[0] ?? "";
  if (scopes.has(firstSegment)) {
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
