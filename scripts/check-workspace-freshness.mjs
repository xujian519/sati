#!/usr/bin/env node
// check-workspace-freshness.mjs
// 开工前基线新鲜度检查。本仓有两条按 file:line 硬编码的产物门禁
// （docs/event-producer-consumer.md 的事件矩阵、docs/code-facts.md 的 claim 标记），
// 在过期基线上分析或改码会产出错误结论与错误生成物。
//
// 判定规则（借 zai-org/ZCode 的设计，按本仓语境重写）：
//   R1 本地分支落后自己的 upstream（任何数量）→ 失败。
//   R2 ahead==0 且落后 origin/main 超阈值 → 失败（纯过期检出：没有任何自有提交）。
//   R3 ahead>0（特性分支有自有提交）且落后 origin/main 超阈值 → 仅告警：分叉本身正常，
//      对齐主线前须先确认改动状态（有未合并草稿时不要盲目 rebase）。
//   R4 无法判定（非 git 工作树 / 无 upstream / 无 origin/main / git 不可用）→ 跳过该规则
//      并打印原因，不算失败。
//
// 与 ZCode 原脚本的两处有意差异：
//   - 默认**不** fetch，要拉最新远端须显式 `--fetch`（避免开发机与 CI 意外联网）；
//     离线时打印 origin/main 参照点的提交与时间，让读数可判。
//   - 阈值默认 10（原脚本 50）：本仓 main 受保护、变更经 PR 高频合入，落后两位数即
//     意味着本地视图与上游已明显不同。
//
// 挂载：package.json 的 `check` 聚合链首位（**不挂 lint**：本检查依赖本地 git 状态与可选
// 网络，不适合每次 lint / pre-commit 都跑）。CI 不跑 `pnpm check`；且 CI 的 checkout 通常
// 是无 upstream 的 detached HEAD，天然走 R4 跳过。
//
// 输出约定：stdout 只留一行结论（成功 `fresh — …` / 跳过 `skipped（原因）`），
// 诊断行走 stderr（`✗` 失败 / `!` 告警 / `·` 跳过的规则与参照点）。
//
// 用法：
//   node scripts/check-workspace-freshness.mjs
//   node scripts/check-workspace-freshness.mjs --fetch
//   node scripts/check-workspace-freshness.mjs --max-behind-main 20

import { execFileSync } from "node:child_process";

const LABEL = "check-workspace-freshness";
const MAIN_REF = "origin/main";
const DEFAULT_MAX_BEHIND_MAIN = 10;

const USAGE = `用法：node scripts/check-workspace-freshness.mjs [--fetch] [--max-behind-main N]
  --fetch               先 git fetch --prune origin（默认离线，不联网）
  --max-behind-main N   落后 ${MAIN_REF} 的提交数阈值（默认 ${DEFAULT_MAX_BEHIND_MAIN}，非负整数）`;

/** 解析参数；失败返回 `{ error }`（调用方以退出码 2 报错）。 */
function parseArgs(argv) {
  let fetch = false;
  let maxBehindMain = DEFAULT_MAX_BEHIND_MAIN;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fetch") {
      fetch = true;
    } else if (arg === "--max-behind-main") {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value < 0) {
        return { error: `--max-behind-main 需要一个非负整数（收到 ${JSON.stringify(raw)}）` };
      }
      maxBehindMain = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
    }
  }
  return { fetch, maxBehindMain };
}

/** 跑一条 git 命令，失败不抛：`{ ok, stdout, stderr }`（均 trim）。 */
function runGit(args, cwd) {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? error?.message ?? "").trim(),
    };
  }
}

const firstLine = text => text.split("\n")[0].trim();

/** 提交数（`git rev-list --count <range>`）；命令失败返回 null。 */
function commitCount(range, cwd) {
  const result = runGit(["rev-list", "--count", range], cwd);
  if (!result.ok) return null;
  const value = Number(result.stdout);
  return Number.isInteger(value) ? value : null;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(`${LABEL}: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }

  const notes = [];
  const warnings = [];
  const failures = [];

  const toplevel = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  if (!toplevel.ok) {
    console.log(`${LABEL}: skipped（不是 git 工作树，或 git 不可用：${firstLine(toplevel.stderr)}）`);
    return 0;
  }
  const repoRoot = toplevel.stdout;

  if (parsed.fetch) {
    const fetched = runGit(["fetch", "--quiet", "--prune", "origin"], repoRoot);
    if (!fetched.ok) {
      warnings.push(`--fetch 失败（${firstLine(fetched.stderr)}）：本次判定基于本地已有的 refs`);
    }
  }

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branchName = branch.ok ? branch.stdout : "(未知)";

  // R1：落后自己的 upstream。
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot);
  let upstreamName = null;
  if (!upstream.ok) {
    notes.push(`${branchName} 没有远端跟踪分支（upstream），跳过 R1（是否忘了 git push -u？）`);
  } else {
    upstreamName = upstream.stdout;
    const behindOwn = commitCount(`HEAD..${upstreamName}`, repoRoot);
    if (behindOwn === null) {
      notes.push(`无法计算与 ${upstreamName} 的距离，跳过 R1`);
    } else if (behindOwn > 0) {
      failures.push(
        `${branchName} 落后自己的远端 ${upstreamName} ${behindOwn} 个提交：先 git merge --ff-only ${upstreamName}`,
      );
    }
  }

  // R2/R3：与 origin/main 的距离。
  let distance = null;
  const mainRef = runGit(["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`], repoRoot);
  if (!mainRef.ok) {
    notes.push(`本地没有 ${MAIN_REF} 参照（未 clone 该分支或未 fetch），跳过 R2/R3`);
  } else {
    const aheadMain = commitCount(`${MAIN_REF}..HEAD`, repoRoot);
    const behindMain = commitCount(`HEAD..${MAIN_REF}`, repoRoot);
    if (aheadMain === null || behindMain === null) {
      notes.push(`无法计算与 ${MAIN_REF} 的距离，跳过 R2/R3`);
    } else {
      distance = `相对 ${MAIN_REF}：ahead ${aheadMain} / behind ${behindMain}（阈值 ${parsed.maxBehindMain}）`;
      if (behindMain > parsed.maxBehindMain) {
        if (aheadMain === 0) {
          failures.push(
            `ahead 0 且落后 ${MAIN_REF} ${behindMain} 个提交，超过阈值 ${parsed.maxBehindMain}：` +
              `先 git merge --ff-only ${MAIN_REF}`,
          );
        } else {
          warnings.push(
            `落后 ${MAIN_REF} ${behindMain} 个提交（超过阈值 ${parsed.maxBehindMain}），` +
              `但本分支有自己的 ${aheadMain} 个提交——分叉本身正常；` +
              "对齐主线前先确认改动状态（有未合并草稿时不要盲目 rebase）",
          );
        }
      }
    }
  }

  if (!parsed.fetch) {
    const tip = runGit(["log", "-1", "--format=%h %cI", MAIN_REF], repoRoot);
    if (tip.ok) {
      notes.push(`未 fetch（默认离线，要拉最新远端加 --fetch）：${MAIN_REF} 参照点为 ${tip.stdout}`);
    }
  }

  const syncedWith = upstreamName === null ? "" : `（与 ${upstreamName} 同步）`;
  const detail = distance === null ? "" : `，${distance}`;

  if (failures.length > 0) {
    console.error(`${LABEL}: 基线过期，先对齐再开工（当前分支：${branchName}）`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    for (const warning of warnings) console.error(`  ! ${warning}`);
    for (const note of notes) console.error(`  · ${note}`);
    return 1;
  }

  console.log(`${LABEL}: fresh — ${branchName}${syncedWith}${detail}`);
  for (const warning of warnings) console.error(`  ! ${warning}`);
  for (const note of notes) console.error(`  · ${note}`);
  return 0;
}

// 用 exitCode 而非 process.exit()：后者会截断尚未刷出的 stdout（管道/重定向时）。
process.exitCode = main();
