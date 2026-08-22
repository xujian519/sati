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
// 用法：node scripts/check-ui-server-boundary.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const UI_SERVER_ROOT = join(REPO_ROOT, "ui", "server");
const ESLINT_CONFIG = join(REPO_ROOT, "ui", "eslint.config.js");

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
  "map/index.js",
  // 有意保留：edgeclaw-memory-core 独立子包，bundle 只打包 lib/（见 release.sh），
  // 改源码入口会破坏桌面打包；lib/ 是其公共 API 编译产物。
  "context/memory/edgeclaw-memory-core/lib/index.js",
]);

// 提取 import/export from / require() / import() 的字符串 specifier。
// 三个捕获组对应三种形态，matchAll 后取首个非空组。
const SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|require\(["']([^"']+)["']\)|import\(["']([^"']+)["']\)/g;

// 剥离注释与字符串/模板字面量，避免其中的假 specifier（如 `// import "..."`、
// `'require("...")'`、`` `import("...")` ``）被误判为真实导入。
// 轻量单遍状态机：按序替换 // 行注释、/* */ 块注释、'...' "..." `...` 字面量
// （字面量内转义符跳过下一字符；模板串内 ${} 不做嵌套处理——门禁只需把假
// specifier 排除在匹配范围外，嵌套模板中真实 import 极少且会被模板语义兜底）。
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === c) {
          j++;
          break;
        } else j++;
      }
      out += " ".repeat(j - i);
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

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
  const config = readFileSync(ESLINT_CONFIG, "utf8");
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
  if (eslintExcept !== null) {
    const missing = [...ALLOWED_SRC_PATHS].filter(p => !eslintExcept.includes(p));
    const extra = eslintExcept.filter(p => !ALLOWED_SRC_PATHS.has(p));
    if (missing.length > 0 || extra.length > 0) {
      if (missing.length > 0) violations.push(`eslint except 缺白名单项：${missing.join(", ")}`);
      if (extra.length > 0) violations.push(`eslint except 多出非白名单项：${extra.join(", ")}`);
    }
  }

  for (const file of collectFiles(UI_SERVER_ROOT)) {
    const source = readFileSync(file, "utf8");
    // 剥离注释/字符串后匹配：等长空格替换保持索引对齐，行号仍可用原文计算。
    const stripped = stripCommentsAndStrings(source);
    for (const match of stripped.matchAll(SPECIFIER_RE)) {
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
