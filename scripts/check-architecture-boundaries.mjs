#!/usr/bin/env node
// check-architecture-boundaries.mjs
// 架构边界与文件规模门禁（挂 pnpm lint）。三条规则：
//
//   R1 src-no-ui-import          src/ 不得 import ui/（Agents.md 铁律 2；反方向 ui/server → src/
//                                由 check-ui-server-boundary.mjs 以 barrel 白名单方式管）
//   R2 ui-src-no-backend-import  ui/src 不得 import 后端 src/——浏览器客户端只能经 gateway / WebSocket
//                                通信；顺带覆盖 ui/tsconfig.json 里已失效的 @sati/web-client 别名
//   R3 file-size                 单文件行数 ≤ 800（防止新的巨型文件；存量见基线文件）
//
// 为什么是脚本而不是 eslint 规则（与 check-ui-server-boundary.mjs 同因）：ui↔src 的 specifier 是
// NodeNext 风格的带扩展名相对路径，eslint 的 import-x 解析器对 .js→.ts 不做回退，规则会静默跳过。
// 这里用 TS 编译器**只提取** specifier 字面量（scripts/lib/import-specifiers.mjs），路径解析自己做。
//
// 存量豁免：docs/technical-debt/architecture-baseline.json —— 命中基线 = 存量不阻塞，其余 exit 1。
// 基线是**方向性**的：它的作用是「冻结存量、拦住新增」，不是「登记即永久合法」；新增条目等于承认
// 一笔新债，必须在 PR 里说明理由。`--update-baseline` 从当前工作树重写基线（会同时删掉已消失的条目）。
//
// 阈值依据（R3 的 800 行）：不是照抄外部项目的 400，而是按本仓现状反推——src 侧只有 16 个文件 >
// 800（最多 1764），ui/src 16 个、ui/server 9 个；400 行会把 112 个 src 文件一次性变成待豁免，
// 白名单大到无法评审。800 行 ≈ 本仓 god function 阈值（300 行）的 2.7 倍，且给「文件该拆了」留出
// 明确信号。可用 --max-file-lines 调整。vendored 子包（src/context/memory/edgeclaw-memory-core）
// 不参与 R3——与 docs/technical-debt/metrics.md 的「文件级指标整体移出」口径一致；它仍受 R1 约束。
//
// 用法：
//   node scripts/check-architecture-boundaries.mjs                 # 门禁（默认）
//   node scripts/check-architecture-boundaries.mjs --max-file-lines 1000
//   node scripts/check-architecture-boundaries.mjs --update-baseline
//   node scripts/check-architecture-boundaries.mjs --root <dir>    # 供负控制测试指向 fixture 树

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractModuleSpecifiers, isRelativeSpecifier, lineAt } from "./lib/import-specifiers.mjs";

const LABEL = "check-architecture-boundaries";
const DEFAULT_MAX_FILE_LINES = 800;
const BASELINE_RELATIVE_PATH = "docs/technical-debt/architecture-baseline.json";

/** 规则 id → 违规的人类可读说明与修复提示。 */
const RULE_GUIDANCE = {
  "src-no-ui-import": "src/ 不得依赖 ui/（Agents.md 铁律 2）：把共享逻辑下沉到 src/，或经 gateway 协议通信",
  "ui-src-no-backend-import": "ui/src 不得导入后端 src/：浏览器客户端只能经 gateway API / WebSocket 通信",
  "file-size": "拆分模块（或确认这是有意的例外后登记进基线，并在 PR 说明理由）",
};

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SERVER_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
const VENDORED_PREFIX = "src/context/memory/edgeclaw-memory-core/";

const USAGE = `用法：node scripts/check-architecture-boundaries.mjs [--max-file-lines N] [--root DIR] [--update-baseline]
  --max-file-lines N   R3 的单文件行数上限（默认 ${DEFAULT_MAX_FILE_LINES}）
  --root DIR           仓库根（默认由脚本位置推导；负控制测试用）
  --update-baseline    按当前工作树重写 ${BASELINE_RELATIVE_PATH}`;

function parseArgs(argv, defaultRoot) {
  let root = defaultRoot;
  let maxFileLines = DEFAULT_MAX_FILE_LINES;
  let updateBaseline = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) return { error: "--root 需要一个目录参数" };
      root = resolve(value);
      i += 1;
    } else if (arg === "--max-file-lines") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: `--max-file-lines 需要一个正整数（收到 ${JSON.stringify(argv[i + 1])}）` };
      }
      maxFileLines = value;
      i += 1;
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
    }
  }
  return { root, maxFileLines, updateBaseline };
}

function collectFiles(dir, extensions, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectFiles(join(dir, entry.name), extensions, out);
    } else if (extensions.some(extension => entry.name.endsWith(extension))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const toPosix = path => path.split(sep).join("/");

/** 相对 root 的 POSIX 路径（root 外的文件返回 `../…`，调用方据此跳过）。 */
const relativeToRoot = (root, file) => toPosix(relative(root, file));

/** 判断 specifier 是否指向 root 下的某个子树（相对 specifier 按文件目录解析，裸 specifier 交给调用方）。 */
function resolvesInto(root, file, specifier, subtree) {
  const resolved = normalize(resolve(dirname(file), specifier));
  const prefix = join(root, subtree);
  if (resolved !== prefix && !resolved.startsWith(prefix + sep)) return null;
  return relativeToRoot(root, resolved);
}

/** R1：src/ 不得 import ui/（相对路径 + 裸包名两种形态）。 */
function checkSrcNoUiImport(root, files) {
  const violations = [];
  for (const file of files) {
    const relativeFile = relativeToRoot(root, file);
    const source = readFileSync(file, "utf8");
    for (const { specifier, offset } of extractModuleSpecifiers(relativeFile, source)) {
      const resolved = isRelativeSpecifier(specifier) ? resolvesInto(root, file, specifier, "ui") : null;
      const bare = !isRelativeSpecifier(specifier) && /^(ui|sati-ui)(\/|$)/.test(specifier);
      if (resolved === null && !bare) continue;
      violations.push({
        rule: "src-no-ui-import",
        file: relativeFile,
        line: lineAt(source, offset),
        detail: specifier,
      });
    }
  }
  return violations;
}

/** R2：ui/src 不得 import 后端 src/（相对路径 + 裸包名 sati / @sati/* 两种形态）。 */
function checkUiSrcNoBackendImport(root, files) {
  const violations = [];
  for (const file of files) {
    const relativeFile = relativeToRoot(root, file);
    const source = readFileSync(file, "utf8");
    for (const { specifier, offset } of extractModuleSpecifiers(relativeFile, source)) {
      const resolved = isRelativeSpecifier(specifier) ? resolvesInto(root, file, specifier, "src") : null;
      const bare = !isRelativeSpecifier(specifier) && /^(sati|@sati)(\/|$)/.test(specifier);
      if (resolved === null && !bare) continue;
      violations.push({
        rule: "ui-src-no-backend-import",
        file: relativeFile,
        line: lineAt(source, offset),
        detail: specifier,
      });
    }
  }
  return violations;
}

/** R3：单文件行数上限（行数口径与 scripts/measure-techdebt.mjs 一致：split("\n").length）。 */
function checkFileSize(root, files, maxFileLines) {
  const violations = [];
  for (const file of files) {
    const relativeFile = relativeToRoot(root, file);
    if (relativeFile.startsWith(VENDORED_PREFIX)) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines <= maxFileLines) continue;
    violations.push({ rule: "file-size", file: relativeFile, line: undefined, detail: undefined, lines });
  }
  return violations;
}

/** 违规的基线键：规则 \t 文件 \t detail（detail 缺省为空——file-size 是文件级规则）。 */
const baselineKey = violation => `${violation.rule}\t${violation.file}\t${violation.detail ?? ""}`;

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    return { error: `${BASELINE_RELATIVE_PATH} 不存在（存量豁免基线缺失）：运行 --update-baseline 重建` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return { error: `${BASELINE_RELATIVE_PATH} 不是合法 JSON：${error.message}` };
  }
  if (!Array.isArray(parsed?.exemptions)) {
    return { error: `${BASELINE_RELATIVE_PATH} 缺少 exemptions 数组` };
  }
  // 用 Map<key, entry> 而非 Set<key>：file-size 棘轮需要读回基线**记录的行数**作为上限，
  // 光有键集合无法判断「存量文件是否又长了」（issue #527）。
  const byKey = new Map(parsed.exemptions.map(entry => [baselineKey(entry), entry]));
  return { byKey, entries: parsed.exemptions };
}

function renderBaseline(violations) {
  const exemptions = violations
    .map(violation => {
      const entry = { rule: violation.rule, file: violation.file };
      if (violation.detail !== undefined) entry.detail = violation.detail;
      if (violation.lines !== undefined) entry.lines = violation.lines;
      return entry;
    })
    .sort((a, b) => baselineKey(a).localeCompare(baselineKey(b)));
  return `${JSON.stringify(
    {
      $comment:
        "架构边界门禁（scripts/check-architecture-boundaries.mjs）的存量豁免清单。命中此处 = 存量不阻塞；新增条目等于承认一笔新债，请在 PR 说明理由。由 --update-baseline 生成，勿手改排序。",
      version: 1,
      exemptions,
    },
    null,
    2,
  )}\n`;
}

function formatViolation(violation) {
  const where = violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
  let what;
  if (violation.rule === "file-size") {
    what =
      violation.baselineLines !== undefined
        ? `${violation.lines} 行 > 基线记录 ${violation.baselineLines} 行（+${
            violation.lines - violation.baselineLines
          } · 棘轮：存量豁免文件不得再增长）`
        : `${violation.lines} 行 > 上限`;
  } else {
    what = `import ${JSON.stringify(violation.detail)}`;
  }
  return `${violation.rule}  ${where}  （${what}）`;
}

function main() {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseArgs(process.argv.slice(2), defaultRoot);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(`${LABEL}: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { root, maxFileLines } = parsed;

  const srcFiles = collectFiles(join(root, "src"), TS_EXTENSIONS);
  const uiSrcFiles = collectFiles(join(root, "ui", "src"), TS_EXTENSIONS);
  const uiServerFiles = collectFiles(join(root, "ui", "server"), SERVER_EXTENSIONS);
  const sizeFiles = [...srcFiles, ...uiSrcFiles, ...uiServerFiles];

  const violations = [
    ...checkSrcNoUiImport(root, srcFiles),
    ...checkUiSrcNoBackendImport(root, uiSrcFiles),
    ...checkFileSize(root, sizeFiles, maxFileLines),
  ].sort((a, b) => baselineKey(a).localeCompare(baselineKey(b)));

  const baselinePath = join(root, BASELINE_RELATIVE_PATH);
  if (parsed.updateBaseline) {
    // 先读旧基线，以便打印本次「追认」的行数 Δ——棘轮的第一手承认动作证据（issue #527）。
    const previous = existsSync(baselinePath) ? readBaseline(baselinePath) : null;
    const prevByKey = previous && !previous.error ? previous.byKey : new Map();
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, renderBaseline(violations));
    console.log(`${LABEL}: 已写入 ${BASELINE_RELATIVE_PATH}（${violations.length} 条存量豁免；改动须随 PR 评审）`);
    const deltas = [];
    for (const violation of violations) {
      if (violation.rule !== "file-size") continue;
      const before = prevByKey.get(baselineKey(violation));
      if (before && typeof before.lines === "number" && violation.lines !== before.lines) {
        deltas.push({ file: violation.file, before: before.lines, after: violation.lines });
      }
    }
    if (deltas.length > 0) {
      const total = deltas.reduce((sum, d) => sum + (d.after - d.before), 0);
      console.log(
        `${LABEL}: ⚠ 本次追认 ${deltas.length} 条 file-size 行数变化（合计 ${total >= 0 ? "+" : ""}${total} 行）——须在 PR 说明理由：`,
      );
      for (const d of deltas) {
        const delta = d.after - d.before;
        console.log(`  · ${d.file}: ${d.before} → ${d.after}（${delta >= 0 ? "+" : ""}${delta}）`);
      }
    }
    return 0;
  }

  const baseline = readBaseline(baselinePath);
  if (baseline.error) {
    console.error(`${LABEL}: ${baseline.error}`);
    return 1;
  }

  // fresh = 新债（键不在基线）+ 棘轮违例（file-size 命中基线但当前行数 > 基线记录值）。
  // 后者是 issue #527 的核心：基线此前只匹配「规则+文件」，记录的行数从不校验，
  // 巨型文件因此可在豁免名义下无声增长（本仓实测 6 条累计 +136 行）。
  const fresh = [];
  for (const violation of violations) {
    const entry = baseline.byKey.get(baselineKey(violation));
    if (!entry) {
      fresh.push(violation);
    } else if (violation.rule === "file-size" && typeof entry.lines === "number" && violation.lines > entry.lines) {
      fresh.push({ ...violation, baselineLines: entry.lines });
    }
  }
  // 基线里已消失的条目不是违规，但要报出来：否则基线会静默变成「永久许可清单」。
  const stale = baseline.entries.filter(entry => !violations.some(v => baselineKey(v) === baselineKey(entry)));

  const scanned = `${srcFiles.length + uiSrcFiles.length + uiServerFiles.length} 文件`;
  if (fresh.length > 0) {
    console.error(`${LABEL}: 发现 ${fresh.length} 处架构边界违规（扫描 ${scanned}）：`);
    for (const violation of fresh) console.error(`  ✗ ${formatViolation(violation)}`);
    const rules = [...new Set(fresh.map(violation => RULE_GUIDANCE[violation.rule]))];
    for (const guidance of rules) console.error(`  → ${guidance}`);
    const grown = fresh.filter(violation => violation.baselineLines !== undefined).length;
    if (grown > 0) {
      console.error(
        `  → 其中 ${grown} 条是存量豁免文件增长（棘轮）：确属合法增长请 --update-baseline 显式追认（会打印 Δ）并在 PR 说明；否则请拆分`,
      );
    }
    console.error(`  存量豁免清单：${BASELINE_RELATIVE_PATH}`);
    return 1;
  }

  console.log(
    `${LABEL}: fresh（3 规则 · ${scanned} · 存量豁免 ${baseline.entries.length} 条${
      stale.length > 0 ? ` · ${stale.length} 条已失效待清理` : ""
    }）`,
  );
  for (const entry of stale) {
    console.error(`  · 基线条目已不再违规，可运行 --update-baseline 清理：${baselineKey(entry)}`);
  }
  return 0;
}

// 用 exitCode 而非 process.exit()：后者会截断尚未刷出的 stdout（管道/重定向时）。
process.exitCode = main();
