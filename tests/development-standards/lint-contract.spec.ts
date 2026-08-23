import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 负控制（negative control）：lint 门禁的"门禁自测"。
 * 参考 docs/development-standards.md §4——"每条门禁要有一份证明它真的在拦的测试"：
 * 对 lint-fixtures/ 下的故意违规 fixture 跑 ESLint（用专用 config），断言它真的会红；
 * 另用一个合规 fixture 断言不错杀。
 *
 * 运行环境：`pnpm test` 从仓库根 build 后以 `node --test dist/tests/**` 运行，
 * 本文件编译到 `dist/tests/development-standards/lint-contract.spec.js`。
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
    dir = parent;
  }
  return dir;
}

function runLint(fixture: string): { status: number | null; stdout: string } {
  const eslint = join(repoRoot(), "node_modules", ".bin", "eslint");
  const result = spawnSync(
    eslint,
    [
      "--config",
      join(repoRoot(), "tests/development-standards/lint-contract.config.mjs"),
      join(repoRoot(), "tests/development-standards/lint-fixtures", fixture),
    ],
    { cwd: repoRoot(), encoding: "utf8" },
  );
  return { status: result.status, stdout: String(result.stdout) + String(result.stderr) };
}

test("no-floating-promises 负控制：未等待的 Promise 会被拦（自测会红）", () => {
  const r = runLint("float-promise.ts");
  assert.ok(r.status !== 0, "eslint 应对未等待的 Promise 非零退出");
  assert.match(r.stdout, /no-floating-promises/);
});

test("no-restricted-imports 负控制：child_process.exec 导入会被拦（自测会红）", () => {
  const r = runLint("danger-import.ts");
  assert.ok(r.status !== 0, "eslint 应对 child_process.exec 导入非零退出");
  assert.match(r.stdout, /no-restricted-imports/);
});

test("lint 门禁不错杀：合规 fixture 零错误", () => {
  const r = runLint("ok.ts");
  assert.equal(r.status, 0, "合规 fixture 应零错误退出");
});
