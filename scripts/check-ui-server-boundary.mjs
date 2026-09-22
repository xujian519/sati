#!/usr/bin/env node
// check-ui-server-boundary.mjs
// ui/server → src/ 导入边界门禁（CLAUDE.md「ui/ 不得直接导入 src/」）。
//
// 为什么不用 eslint 的 import-x/no-restricted-paths：
// ui/server 是 NodeNext 风格（import "../../src/xxx.js"），eslint 的 resolver
// （unrs-resolver）对带 .js 后缀的 specifier 不做 .ts 回退——解析失败导致
// no-restricted-paths 静默跳过（2026-08-17 实测：白名单增减均不触发）。
// 本脚本做纯路径静态校验，不依赖 eslint 解析，作为该边界的实际门禁。
//
// ⚠️ 2026-09-22 修复「空转」缺陷：原先本脚本先用状态机把注释**与字符串字面量**整体置空，
// 再用带引号的正则提取 specifier —— specifier 本身就在字符串里，置空后正则永远匹配不到，
// 门禁从上线起就从未拦下任何导入（实测：伪造 ui/server → src/patent/… 深层导入仍输出 fresh）。
// 现改为用 TS 编译器提取 specifier 字面量（scripts/lib/import-specifiers.mjs），
// 注释/字符串里的假 import 天然不在语法树里；负控制见 scripts/check-ui-server-boundary.test.mjs。
//
// 规则：ui/server（排除测试文件——测试可直接 import 非 barrel 内部路径，
// 如 pilotPaths.test.js 深引 src/pilot/paths.js，属测试豁免的有意边界）对
// src/ 的相对 import 必须命中白名单（barrel 入口 + 有意保留的 edgeclaw lib
// 编译产物入口）。
//
// 加载面代价说明：收口以顶层 barrel 为主（model/cron/web 等），比原深层单
// 模块加载面大（ESM 运行时无 tree-shaking），仅影响 ui/server 启动时间、
// 无正确性影响；cli 因连带 createLocalGateway 全树采用子 barrel 细粒度化。
// 如需收紧 model/cron 加载面，可建子 barrel（如 model/providerEndpoint/index.ts），
// 加入白名单即可。
//
// 挂载：ui/package.json lint 脚本末尾（与 unused-imports 门禁同处）。
// 用法：node scripts/check-ui-server-boundary.mjs [--root DIR]   # --root 供负控制测试指向 fixture 树

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractModuleSpecifiers, isRelativeSpecifier } from "./lib/import-specifiers.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 解析 `--root`（默认仓库根；负控制测试指向 fixture 树）。 */
function resolveRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return SCRIPT_ROOT;
  const value = argv[index + 1];
  if (value === undefined) {
    console.error("check-ui-server-boundary: --root 需要一个目录参数");
    process.exit(2);
  }
  return resolve(value);
}

const REPO_ROOT = resolveRoot(process.argv.slice(2));
const SRC_ROOT = join(REPO_ROOT, "src");
const UI_SERVER_ROOT = join(REPO_ROOT, "ui", "server");
const ESLINT_CONFIG = join(REPO_ROOT, "ui", "eslint.config.js");

// 白名单：相对 src/ 的允许路径（barrel 入口 + edgeclaw lib 有意例外）。
// 新 barrel 入口加入后，此处与 ui/eslint.config.js 的 except 列表需同步。
export const ALLOWED_SRC_PATHS = new Set([
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

// specifier 提取见 scripts/lib/import-specifiers.mjs（TS AST；本文件不再自带状态机）。

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (
      // .cjs 是 CJS 逃生口（ui/package.json type:module），require() 形态经此可能绕过；
      // 一并纳入门禁。ui/server 当前无 .cjs，此覆盖为前瞻性。
      /\.(js|mjs|cjs)$/.test(entry) &&
      !/\.test\./.test(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

// 解析 ui/eslint.config.js 的 no-restricted-paths except 列表（意图文档），
// 与本白名单比对，防两处手工清单漂移。eslint 规则本身对 NodeNext .js
// specifier 不生效（见文件头注释），except 仅作意图声明，故此处自检兜底。
function readEslintExceptList() {
  let config;
  try {
    config = readFileSync(ESLINT_CONFIG, "utf8");
  } catch {
    // 文件缺失/不可读走与「正则失配」同一条路径（报违规、不崩栈）。
    return null;
  }
  const except = [];
  const re = /except:\s*\[([\s\S]*?)\]/;
  const m = re.exec(config);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const item = /["']([^"']+)["']/.exec(line.trim());
    if (item) except.push(item[1]);
  }
  return except;
}

function main() {
  const violations = [];

  // N3：eslint except 与白名单一致性自检（防漂移）。
  const eslintExcept = readEslintExceptList();
  if (eslintExcept === null) {
    violations.push("无法解析 ui/eslint.config.js 的 except 列表（正则失配，防漂移自检被禁用）");
  } else {
    const missing = [...ALLOWED_SRC_PATHS].filter(p => !eslintExcept.includes(p));
    const extra = eslintExcept.filter(p => !ALLOWED_SRC_PATHS.has(p));
    if (missing.length > 0 || extra.length > 0) {
      if (missing.length > 0) violations.push(`eslint except 缺白名单项：${missing.join(", ")}`);
      if (extra.length > 0) violations.push(`eslint except 多出非白名单项：${extra.join(", ")}`);
    }
  }

  for (const file of collectFiles(UI_SERVER_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const { specifier, offset } of extractModuleSpecifiers(relative(REPO_ROOT, file), source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = normalize(resolve(dirname(file), specifier));
      // import 目录在 Node ESM 中直接报错，无需防御 resolved === SRC_ROOT。
      if (!resolved.startsWith(SRC_ROOT + sep)) continue;
      const rel = relative(SRC_ROOT, resolved).split(sep).join("/");
      if (!ALLOWED_SRC_PATHS.has(rel)) {
        const line = source.slice(0, offset).split("\n").length;
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

// 仅当直接以脚本运行时执行；被 import 时（scripts/check-ui-server-boundary.test.mjs 读白名单）
// 只暴露常量，不跑门禁。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) main();
