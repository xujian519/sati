#!/usr/bin/env node
/**
 * lint-staged entry point (see package.json > lint-staged).
 *
 * Routes staged files to the right toolchain in this pnpm workspace:
 *   - Biome formats everything from the repo root (biome.json)
 *   - ESLint fixes ui/** files with the ui package's config (ui/eslint.config.js)
 *   - ESLint fixes everything else with the root config (eslint.config.mjs)
 *
 * Exits non-zero if any tool fails, aborting the commit.
 */
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
const uiFiles = files.filter(f => f.startsWith("ui/"));
const rootFiles = files.filter(f => !f.startsWith("ui/"));

let failed = false;

function run(cwd, args) {
  const result = spawnSync("npx", ["--no-install", ...args], {
    cwd,
    stdio: "inherit",
    // Windows: npx is a .cmd shim which child_process.spawn can't resolve
    // without a shell (ENOENT). shell:true routes it through cmd.exe/sh,
    // which also works on macOS/Linux.
    shell: true,
  });
  if (result.status !== 0) failed = true;
}

if (files.length > 0) {
  // --no-errors-on-unmatched: biome.json ignores 数据目录（tests/fixtures/** 等），
  // staged 文件全被 ignore 时 biome format 会以非零退出——这不属于格式错误，应放行。
  run(process.cwd(), ["biome", "format", "--write", "--no-errors-on-unmatched", ...files]);
}
if (rootFiles.length > 0) {
  run(process.cwd(), ["eslint", "--fix", ...rootFiles]);
}
if (uiFiles.length > 0) {
  run(process.cwd() + "/ui", ["eslint", "--fix", ...uiFiles.map(f => f.replace(/^ui\//, ""))]);
}

process.exit(failed ? 1 : 0);
