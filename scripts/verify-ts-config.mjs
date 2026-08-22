#!/usr/bin/env node
/**
 * 编译器底线开关的配置钉（config-pin）：断言根/UI 两份 tsconfig 的
 * `strict`、`noFallthroughCasesInSwitch` 没有被悄悄放宽。
 *
 * 这是 `pnpm check` 的轻量自检（无需构建）；`tests/development-standards/verify-config.spec.ts`
 * 是同一断言的测试级负控制（证明这类收紧确实会被拦）。二者承载同一意图：
 * 反向校验"typecheck 门禁真的在按预期收紧编译"，防止 `strict: false` 回归而 `pnpm check` 仍绿。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) process.exit(1);
    dir = parent;
  }
  return dir;
}

/**
 * JSONC 去注释（容错、避免误删字符串内容）：逐字符扫描，仅剥离字符串外的
 * `//` 行注释与 `/* ... *\/` 块注释；字符串内的 `//`、`/*`（如 URL、glob `path`）
 * 原样保留。任何未闭合字符串/注释会在 JSON.parse 处响亮抛错。
 */
function stripJsoncComments(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripJsoncComments(text));
}

function fail(msg) {
  console.error(`verify-ts-config: ${msg}`);
  process.exit(1);
}

const root = parseJsonc(readFileSync(join(repoRoot(), "tsconfig.json"), "utf8")).compilerOptions;
if (root.strict !== true) fail("tsconfig.json: strict 必须保持 true");
if (root.noFallthroughCasesInSwitch !== true) {
  fail("tsconfig.json: noFallthroughCasesInSwitch 必须保持 true（switch 穿透是缺陷类）");
}

const ui = parseJsonc(readFileSync(join(repoRoot(), "ui/tsconfig.json"), "utf8")).compilerOptions;
if (ui.strict !== true) fail("ui/tsconfig.json: strict 必须保持 true");

console.log("verify-ts-config: OK (strict + noFallthroughCasesInSwitch present in root/ui tsconfig)");
