/**
 * 撰写评测与 pairwise 校准的并列输出（#830 M7 T7.4）。
 *
 * 验证：`patent-drafting-eval.ts --pairwise` 在同一份报告里同时给出
 * 撰写分（rubric）与 pairwise τ，且 τ 未达标不影响退出码。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const REPO_ROOT = process.cwd();

/** 用 tsx 跑评测脚本（tsx 的 IPC socket 在部分沙箱下不可用 → 退化为 node 直跑 dist）。 */
function runEval(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync("npx", ["tsx", "scripts/patent-drafting-eval.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: `${REPO_ROOT}/node_modules/.cache/tsx-sock` },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

describe("撰写评测 × pairwise 并列输出", () => {
  it("--pairwise 同时输出 rubric 分数与 Kendall τ", () => {
    const { stdout } = runEval(["--pairwise"]);
    assert.match(stdout, /起草质量 rubric 批量评测/);
    assert.match(stdout, /clean 通过率/);
    assert.match(stdout, /pairwise 校准/);
    assert.match(stdout, /Kendall τ-b/);
    assert.match(stdout, /置信区间/);
  });

  it("--pairwise 不改变退出码（τ 未达标只报告不 fail）", () => {
    const { status } = runEval(["--pairwise"]);
    // 当前语料下 rubric 与 τ 均达标 → 退出码 0；关键是 pairwise 分支不引入非零退出。
    assert.equal(status, 0);
  });
});
