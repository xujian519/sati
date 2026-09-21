// check-workspace-freshness.test.mjs
// 负控制：证明「基线过期」这类回归真的会被 check-workspace-freshness.mjs 拦下
// （docs/development-standards.md §4「一个守卫只有当回归真的会撞红它才算守卫」）。
//
// 做法：在临时目录里搭 local-origin 三件套（bare origin + seed 推送 + client 克隆），
// 用真实 git 操作制造落后/分叉/无参照等场景，再跑目标脚本断言退出码与输出。
// 不联网：origin 是本地路径（file 传输），`--fetch` 亦只走本地。
//
// 挂载：package.json 的 `test:pr-tooling`（CI quality job 的 "Self-test PR tooling gates" 步骤）。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-workspace-freshness.mjs", import.meta.url));
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// 屏蔽用户/系统 git 配置（含默认分支名与签名），让场景完全由本文件决定。
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_AUTHOR_NAME: "freshness-test",
  GIT_AUTHOR_EMAIL: "freshness-test@example.com",
  GIT_COMMITTER_NAME: "freshness-test",
  GIT_COMMITTER_EMAIL: "freshness-test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 跑目标脚本；返回 `{ status, stdout, stderr }`。 */
function runCheck(cwd, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.error, undefined, `无法启动脚本：${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 单行结论是输出契约：stdout 只留一行（诊断走 stderr）。 */
function assertSingleLine(stdout) {
  assert.equal(stdout.trim().split("\n").length, 1, `stdout 应只有一行结论，实际：${JSON.stringify(stdout)}`);
}

function makeSandbox(t, name) {
  const root = mkdtempSync(join(tmpdir(), `sati-freshness-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function commitFile(repo, fileName, content, message) {
  writeFileSync(join(repo, fileName), content);
  git(repo, ["add", fileName]);
  git(repo, ["commit", "--quiet", "-m", message]);
}

/**
 * 搭一个 bare origin + seed 仓库，seed 已有 `commitCount` 个提交并推到 origin。
 * 返回 `{ origin, seed }`；seed 保留为「向上游继续推进」的手。
 */
function buildUpstream(root, commitCount) {
  const origin = join(root, "origin.git");
  git(root, ["init", "--bare", "--quiet", "--initial-branch=main", origin]);
  const seed = join(root, "seed");
  git(root, ["init", "--quiet", "--initial-branch=main", seed]);
  for (let index = 1; index <= commitCount; index += 1) {
    commitFile(seed, `c${index}.txt`, `c${index}\n`, `chore: c${index}`);
  }
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "--quiet", "-u", "origin", "main"]);
  return { origin, seed };
}

function cloneFrom(root, origin, dirName = "client") {
  git(root, ["clone", "--quiet", origin, dirName]);
  return join(root, dirName);
}

test("新鲜的检出（与 upstream 同步、与 origin/main 同点）判为 fresh", t => {
  const root = makeSandbox(t, "fresh");
  const { origin } = buildUpstream(root, 3);
  const client = cloneFrom(root, origin);

  const result = runCheck(client);
  assert.equal(result.status, 0, result.stderr);
  assertSingleLine(result.stdout);
  assert.match(result.stdout, /^check-workspace-freshness: fresh — main/);
  assert.match(result.stdout, /相对 origin\/main：ahead 0 \/ behind 0/);
  // 默认离线：参照点时间要打印出来，否则读数不可判。
  assert.match(result.stderr, /未 fetch（默认离线/);
});

test("落后自己的远端即失败，并给出可操作的修复命令（R1）", t => {
  const root = makeSandbox(t, "behind-own");
  const { origin } = buildUpstream(root, 3);
  const client = cloneFrom(root, origin);
  git(client, ["reset", "--hard", "HEAD~2"]);

  // 抬高 main 阈值以隔离 R2，只让 R1 说话。
  const result = runCheck(client, ["--max-behind-main", "50"]);
  assert.equal(result.status, 1);
  assertSingleLine(result.stdout);
  assert.match(result.stderr, /基线过期/);
  assert.match(result.stderr, /main 落后自己的远端 origin\/main 2 个提交/);
  assert.match(result.stderr, /git merge --ff-only origin\/main/);
});

test("ahead==0 且落后 origin/main 超阈值即失败（R2）", t => {
  const root = makeSandbox(t, "stale-baseline");
  const { origin } = buildUpstream(root, 5);
  const client = cloneFrom(root, origin);
  // 无自有提交的过期分支：起点落后主线 3 个提交，且没有 upstream（R1 不参与）。
  git(client, ["checkout", "--quiet", "-b", "feat/stale", "HEAD~3"]);

  const stale = runCheck(client, ["--max-behind-main", "1"]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /ahead 0 且落后 origin\/main 3 个提交，超过阈值 1/);
  assert.match(stale.stderr, /没有远端跟踪分支/);

  // 同一检出抬高阈值即放行：证明阈值是唯一的判据。
  const tolerated = runCheck(client, ["--max-behind-main", "5"]);
  assert.equal(tolerated.status, 0, tolerated.stderr);
  assert.match(tolerated.stdout, /相对 origin\/main：ahead 0 \/ behind 3（阈值 5）/);
});

test("特性分支有自有提交时只告警不失败（R3）", t => {
  const root = makeSandbox(t, "diverged");
  const { origin } = buildUpstream(root, 5);
  const client = cloneFrom(root, origin);
  git(client, ["checkout", "--quiet", "-b", "feat/work", "HEAD~3"]);
  commitFile(client, "w1.txt", "w1\n", "feat: w1");

  const result = runCheck(client, ["--max-behind-main", "1"]);
  assert.equal(result.status, 0, result.stderr);
  assertSingleLine(result.stdout);
  assert.match(result.stdout, /^check-workspace-freshness: fresh — feat\/work/);
  assert.match(result.stdout, /ahead 1 \/ behind 3/);
  assert.match(result.stderr, /本分支有自己的 1 个提交——分叉本身正常/);
});

test("默认不联网；--fetch 更新远端参照并改变判定", t => {
  const root = makeSandbox(t, "fetch");
  const { origin, seed } = buildUpstream(root, 3);
  const client = cloneFrom(root, origin);

  // 上游在克隆之后又推进 4 个提交：客户端的 origin/main ref 仍是旧的。
  for (let index = 4; index <= 7; index += 1) {
    commitFile(seed, `c${index}.txt`, `c${index}\n`, `chore: c${index}`);
  }
  git(seed, ["push", "--quiet", "origin", "main"]);
  const remoteMainSha = git(seed, ["rev-parse", "HEAD"]);

  const offline = runCheck(client);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /behind 0/);
  assert.notEqual(git(client, ["rev-parse", "origin/main"]), remoteMainSha, "默认不应联网，ref 必须仍是旧的");

  const synced = runCheck(client, ["--fetch"]);
  assert.equal(git(client, ["rev-parse", "origin/main"]), remoteMainSha, "--fetch 应更新 origin/main");
  assert.equal(synced.status, 1);
  assert.match(synced.stderr, /落后自己的远端 origin\/main 4 个提交/);
});

test("无 origin/main 参照时跳过 R2/R3 且不算失败", t => {
  const root = makeSandbox(t, "no-origin-main");
  const repo = join(root, "local");
  git(root, ["init", "--quiet", "--initial-branch=main", repo]);
  commitFile(repo, "a.txt", "a\n", "chore: a");

  const result = runCheck(repo);
  assert.equal(result.status, 0, result.stderr);
  assertSingleLine(result.stdout);
  assert.match(result.stderr, /没有 origin\/main 参照/);
  assert.match(result.stderr, /没有远端跟踪分支/);
});

test("非 git 工作树 → 跳过且不算失败", t => {
  const root = makeSandbox(t, "not-a-repo");

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assertSingleLine(result.stdout);
  assert.match(result.stdout, /^check-workspace-freshness: skipped（不是 git 工作树/);
});

test("--max-behind-main 非法取值以退出码 2 报错", t => {
  const root = makeSandbox(t, "bad-arg");
  const { origin } = buildUpstream(root, 1);
  const client = cloneFrom(root, origin);

  for (const bad of ["abc", "-1", undefined]) {
    const result = runCheck(client, bad === undefined ? ["--max-behind-main"] : ["--max-behind-main", bad]);
    assert.equal(result.status, 2, `参数 ${JSON.stringify(bad)} 应报退出码 2`);
    assert.match(result.stderr, /--max-behind-main 需要一个非负整数/);
  }

  const unknown = runCheck(client, ["--fetch=now"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /无法识别的参数/);

  const help = runCheck(client, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^用法：node scripts\/check-workspace-freshness\.mjs/);
});
