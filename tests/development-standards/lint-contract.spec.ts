import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 负控制（negative control）：lint 门禁的"门禁自测"，两层：
 * 1. 配置断言——读根 eslint.config.mjs，断言危险 API/类型感知规则保持为 error（防根配置悄悄失效）。
 * 2. 机制证明——用专用 config 对 lint-fixtures/ 的故意违规 fixture 跑 ESLint，断言真的会红；
 *    另用合规 fixture 断言不错杀。
 * 参考 docs/development-standards.md §4（与 verify-config.spec.ts 同构的双层模式）。
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
    // Windows 下 .bin/eslint 是无扩展名 shim，需经 shell 解析（.cmd）。CI 的 Windows job 不跑后端
    // 测试，但本地 Windows `pnpm test` 需要可移植。
    { cwd: repoRoot(), encoding: "utf8", shell: process.platform === "win32" },
  );
  return { status: result.status, stdout: String(result.stdout) + String(result.stderr) };
}

test("lint 门禁配置断言：根 eslint.config 保持危险 API 与类型感知规则为 error", () => {
  const cfg = readFileSync(join(repoRoot(), "eslint.config.mjs"), "utf8");
  assert.match(cfg, /"@typescript-eslint\/no-floating-promises": "error"/);
  assert.match(cfg, /"@typescript-eslint\/no-misused-promises": "error"/);
  assert.match(cfg, /"no-restricted-imports": \[/);
});

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
