import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// 门禁自测（证明"它真的会红"）：用与项目相同的编译器底线开关编译一个违规 fixture，
// 断言 tsc 非零退出。这验证上述两个开关不是"配置写对了但没在拦"的空转。
test("typecheck 门禁真的会拦：编译器底线开关对违规报错（自测会红）", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-verify-"));
  const fixture = join(dir, "fixture.ts");
  const tsc = join(repoRoot(), "node_modules", ".bin", "tsc");
  try {
    // noFallthroughCasesInSwitch：case 1 穿透到 case 2（无 break）应被拒绝。
    writeFileSync(
      fixture,
      "function f(n: number): void { switch (n) { case 1: console.log('a'); case 2: console.log('b'); } }\n",
    );
    const fallthrough = spawnSync(tsc, ["--noEmit", "--noFallthroughCasesInSwitch", fixture], { encoding: "utf8" });
    assert.ok(fallthrough.status !== 0, "tsc 应在 --noFallthroughCasesInSwitch 下拒绝穿透的 switch");
    assert.match(String(fallthrough.stdout), /error TS/, "tsc 应输出 error TS…（诊断写 stdout）");
    // strict（strictNullChecks）：把 null 赋给 string 应被拒绝。
    writeFileSync(fixture, "const s: string = null;\n");
    const strict = spawnSync(tsc, ["--noEmit", "--strict", fixture], { encoding: "utf8" });
    assert.ok(strict.status !== 0, "tsc 应在 --strict 下拒绝 null 赋给 string");
    assert.match(String(strict.stdout), /error TS/, "tsc 应输出 error TS…（诊断写 stdout）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
