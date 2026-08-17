#!/usr/bin/env node
// check-ui-server-boundary.mjs
// ui/server → src/ 导入边界门禁（CLAUDE.md「ui/ 不得直接导入 src/」）。
//
// 为什么不用 eslint 的 import-x/no-restricted-paths：
// ui/server 是 NodeNext 风格（import "../../src/xxx.js"），eslint 的 resolver
// （unrs-resolver）对带 .js 后缀的 specifier 不做 .ts 回退——解析失败导致
// no-restricted-paths 静默跳过（2026-08-17 实测：白名单增减均不触发）。
// 本脚本做纯路径静态校验，不依赖 TS 解析，作为该边界的实际门禁。
//
// 规则：ui/server（排除测试文件）对 src/ 的相对 import 必须命中白名单
// （barrel 入口 + 有意保留的 edgeclaw lib 编译产物入口）。
//
// 挂载：ui/package.json lint 脚本末尾（与 unused-imports 门禁同处）。
// 用法：node scripts/check-ui-server-boundary.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const UI_SERVER_ROOT = join(REPO_ROOT, "ui", "server");

// 白名单：相对 src/ 的允许路径（barrel 入口 + edgeclaw lib 有意例外）。
// 新 barrel 入口加入后，此处与 ui/eslint.config.js 的 except 列表需同步。
const ALLOWED_SRC_PATHS = new Set([
  "web/server/index.js",
  "cron/index.js",
  "cli/proxy.js", // 有意保留：cli 根单文件、轻依赖；顶层 cli barrel 会连带 createLocalGateway 全树
  "cli/commands/index.js",
  "context/budget/index.js",
  "gateway/index.js",
  "status/index.js",
  "web/client/index.js",
  "model/index.js",
  "network/index.js",
  "adapters/channel/protocol/index.js",
  "pilot/index.js",
  // 有意保留：edgeclaw-memory-core 独立子包，bundle 只打包 lib/（见 release.sh），
  // 改源码入口会破坏桌面打包；lib/ 是其公共 API 编译产物。
  "context/memory/edgeclaw-memory-core/lib/index.js",
]);

// 提取 import/export from / require() / import() 的字符串 specifier。
// 三个捕获组对应三种形态，matchAll 后取首个非空组。
const SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|require\(["']([^"']+)["']\)|import\(["']([^"']+)["']\)/g;

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(js|mjs)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const violations = [];
  for (const file of collectFiles(UI_SERVER_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match.slice(1).find(Boolean);
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolved = normalize(resolve(dirname(file), specifier));
      // import 目录在 Node ESM 中直接报错，无需防御 resolved === SRC_ROOT。
      if (!resolved.startsWith(SRC_ROOT + sep)) continue;
      const rel = relative(SRC_ROOT, resolved).split(sep).join("/");
      if (!ALLOWED_SRC_PATHS.has(rel)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${relative(REPO_ROOT, file)}:${line} → src/${rel}`);
      }
    }
  }
  if (violations.length > 0) {
    console.error("check-ui-server-boundary: ui/server 存在未白名单的 src/ 深层导入：");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n允许的 src/ 入口（${ALLOWED_SRC_PATHS.size} 个）：`);
    for (const p of [...ALLOWED_SRC_PATHS].sort()) console.error(`  ✓ src/${p}`);
    process.exit(1);
  }
  console.log("check-ui-server-boundary: fresh");
}

main();
