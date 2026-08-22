import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 负控制（negative control）：断言 typecheck 的编译器底线开关没有被悄悄放宽。
 * 参考 docs/development-standards.md §4 负控制——"会误报的门禁比没有更糟，
 * 每条门禁要有一份证明它真的在拦的测试"。
 *
 * 运行环境：`pnpm test` 从仓库根 build 后以 `node --test dist/tests/**` 运行，
 * 本文件编译到 `dist/tests/development-standards/verify-config.spec.js`。
 * 这里从编译产物位置向上走到 package.json 定位仓库根，读取根/UI 两份 tsconfig。
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

/** 极简 JSONC 解析：去块注释与整行 `//` 注释后 JSON.parse。仅用于 tsconfig——当前两份 tsconfig 的注释均为整行、无尾随逗号；若未来出现行内注释/尾随逗号，会在原位置报 JSON 语法错误（响亮失败，而非静默损坏字符串值）。 */
function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, ""));
}

function readCompilerOptions(rel: string): Record<string, unknown> {
  const json = parseJsonc(readFileSync(join(repoRoot(), rel), "utf8")) as { compilerOptions: Record<string, unknown> };
  return json.compilerOptions;
}

test("根 tsconfig 编译器底线开关不被放宽", () => {
  const opts = readCompilerOptions("tsconfig.json");
  assert.strictEqual(opts.strict, true, "strict 必须保持 true");
  assert.strictEqual(
    opts.noFallthroughCasesInSwitch,
    true,
    "noFallthroughCasesInSwitch 必须保持 true（switch 穿透是缺陷类）",
  );
  // TODO(G1-b/G1-c, docs/development-standards.md §7 第 2 步)：
  // 开启 noUncheckedIndexedAccess / exactOptionalPropertyTypes 后在此追加断言。
});

test("UI tsconfig 编译器底线开关不被放宽", () => {
  const opts = readCompilerOptions("ui/tsconfig.json");
  assert.strictEqual(opts.strict, true, "ui strict 必须保持 true");
});
