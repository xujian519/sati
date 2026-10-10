#!/usr/bin/env node
// gen-degradation-candidates.mjs
// 降级候选漂移扫描（informational；处理流程与退出判据见 docs/degradation-runbook.md）。
//
// 目的：把「新增外部/软依赖未登记 registry」变成 CI 可感知——模式扫描外部触点，
// 与两份声明式资产做差：
//   - assets/degradation/registry.yaml            已登记条目（component 文件级覆盖）
//   - assets/degradation/candidates-baseline.yaml 已确认项（known-unregistered / waived）
//   新增候选 = 命中文件 − registry 覆盖 − 已确认项
//
// 输出三个集合（语义见 runbook）：
//   - 新增候选：「疑似未登记依赖」——按三选一处理（补登记 / 记基线 / 修模式）；
//   - 已确认项：基线内文件，展示 disposition 与理由（不算候选，不阻塞转型）；
//   - 失效/冗余基线：基线条目不再命中或已被 registry 覆盖——同 registry「冗余豁免即红」
//     精神，--check 下失败（豁免是「暂时没有」的书面承认，不是永久标签）。
//
// 有意保留的启发式局限（防误报淹没信号；「漏了什么」必须可见、可写进报告）：
//   - 文件级匹配：已登记文件**内部**新增的触点不会被报（逐行棘轮留待硬门禁后评估）；
//   - 不剔除注释/字符串内命中（注释提及可记基线 waived 并注明「模式误报」）；
//   - 不解析动态 import / 间接调用（如经变量持有再调用的 spawn）；
//   - 不含裸 `exec(`（RegExp 误报多）——`child_process` import 已覆盖其调用文件；
//   - 跳过 .d.* 声明文件与 *.spec.* / *.test.*；
//   - 跳过 gitignore 的 vendored 编译输出（edgeclaw-memory-core/lib/）——CI 无构建、本地有，
//     跳过防本地/CI 扫描口径分叉（源码已在 src 树内被扫）。
//
// 用法：
//   node scripts/gen-degradation-candidates.mjs                # 报告（默认 exit 0，informational）
//   node scripts/gen-degradation-candidates.mjs --check        # 有新增候选或失效基线 → exit 1（硬门禁语义）
//   node scripts/gen-degradation-candidates.mjs --report FILE  # 另写 markdown 报告（CI artifact）
//   node scripts/gen-degradation-candidates.mjs --root DIR     # fixture 根（负控制测试用）

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const LABEL = "gen-degradation-candidates";
const REGISTRY_RELATIVE_PATH = "assets/degradation/registry.yaml";
const BASELINE_RELATIVE_PATH = "assets/degradation/candidates-baseline.yaml";
const DEFAULT_ROOTS = ["src", "ui/src", "ui/server", "scripts", "apps/desktop/src"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
/** 构建产物目录（gitignore 的 vendored 编译输出）：CI 无构建、本地有——按相对路径精确跳过。 */
const SKIPPED_RELATIVE_DIRECTORIES = ["src/context/memory/edgeclaw-memory-core/lib"];
const SPEC_FILE_PATTERN = /\.(?:spec|test)\.[^.]+$/;
const DECLARATION_FILE_PATTERN = /\.d\.[^.]+$/;
const DISPOSITIONS = new Set(["known-unregistered", "waived"]);

/** 外部触点模式集（文件级命中）。扩展协议：加模式后跑一次扫描，把差集清零（登记或记基线）。 */
const PATTERNS = [
  { id: "network-fetch", regex: /\bnetworkFetch\b/ },
  { id: "child-process", regex: /\bchild_process\b|\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/ },
  { id: "websocket", regex: /\bWebSocketServer\b|\bWebSocketImpl\b|\bnew\s+WebSocket\b/ },
  { id: "mcp-sdk", regex: /@modelcontextprotocol/ },
];

const USAGE = `用法：node scripts/gen-degradation-candidates.mjs [--check] [--report FILE] [--root DIR]
  --check       有新增候选或失效/冗余基线时 exit 1（默认 exit 0，仅输出报告）
  --report FILE 另写 markdown 报告到 FILE（CI artifact）
  --root DIR    仓库根（默认由脚本位置推导；负控制测试用）`;

function parseArgs(argv, defaultRoot) {
  let root = defaultRoot;
  let check = false;
  let report = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) return { error: "--root 需要一个目录参数" };
      root = resolve(value);
      i += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--report") {
      const value = argv[i + 1];
      if (value === undefined) return { error: "--report 需要一个文件参数" };
      report = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
    }
  }
  return { root, check, report };
}

function collectFiles(dir, out = [], skippedAbsolute = new Set()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = join(dir, entry.name);
      if (SKIPPED_DIRECTORIES.has(entry.name) || skippedAbsolute.has(child)) continue;
      collectFiles(child, out, skippedAbsolute);
    } else if (
      EXTENSIONS.some(extension => entry.name.endsWith(extension)) &&
      !SPEC_FILE_PATTERN.test(entry.name) &&
      !DECLARATION_FILE_PATTERN.test(entry.name)
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;
const collapse = text => text.replace(/\s+/g, " ").trim();

/** 单文件命中：每个模式取首个匹配（file:line + 片段），供分类与复核。 */
function scanFile(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const matches = [];
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(source);
    if (match === null) continue;
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = source.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
    matches.push({
      id: pattern.id,
      line: lineOf(source, match.index),
      snippet: collapse(source.slice(lineStart, lineEnd)).slice(0, 80),
    });
  }
  return matches.length > 0 ? matches : null;
}

/** 读取 registry 的 component 集合（文件级覆盖口径）。 */
function loadRegistryComponents(root) {
  const registryPath = join(root, REGISTRY_RELATIVE_PATH);
  let parsed;
  try {
    parsed = parseYaml(readFileSync(registryPath, "utf8"));
  } catch (error) {
    throw new Error(`读取 ${REGISTRY_RELATIVE_PATH} 失败：${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`${REGISTRY_RELATIVE_PATH} 缺少 entries 数组`);
  }
  const components = new Set();
  for (const entry of parsed.entries) {
    if (entry !== null && typeof entry === "object" && typeof entry.component === "string") {
      components.add(entry.component);
    }
  }
  return components;
}

/** 读取并校验 candidates-baseline.yaml。返回 { entries, problems }。 */
function loadBaseline(root) {
  const baselinePath = join(root, BASELINE_RELATIVE_PATH);
  let parsed;
  try {
    parsed = parseYaml(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return { entries: [], problems: [`读取 ${BASELINE_RELATIVE_PATH} 失败：${error.message}`] };
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    return { entries: [], problems: [`${BASELINE_RELATIVE_PATH} 缺少 entries 数组`] };
  }
  const entries = [];
  const problems = [];
  const seen = new Set();
  parsed.entries.forEach((entry, index) => {
    const label = `第 ${index + 1} 条`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`[${label}] 不是对象`);
      return;
    }
    const { path, disposition, reason } = entry;
    if (typeof path !== "string" || path.trim().length === 0) {
      problems.push(`[${label}] path 缺失`);
      return;
    }
    if (!DISPOSITIONS.has(disposition)) {
      problems.push(`[${path}] disposition 必须是 known-unregistered / waived（收到 ${JSON.stringify(disposition)}）`);
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      problems.push(`[${path}] reason 缺失——已确认项必须写清依据`);
    }
    if (seen.has(path)) problems.push(`[${path}] 重复条目`);
    seen.add(path);
    entries.push({ path, disposition, reason });
  });
  return { entries, problems };
}

function renderReport({ root, scanned, hits, coveredPaths, knownEntries, fresh, stale }) {
  const lines = [];
  lines.push("# 降级候选漂移报告（gen-degradation-candidates）");
  lines.push("");
  lines.push(`- 生成：${new Date().toISOString()}；根：${root}`);
  lines.push(`- 模式集：${PATTERNS.map(pattern => pattern.id).join(" / ")}`);
  lines.push(
    `- 扫描 ${scanned} 文件；命中 ${hits.size}；registry 覆盖 ${coveredPaths.length}；已确认 ${knownEntries.length}；新增候选 ${fresh.length}；失效/冗余基线 ${stale.length}`,
  );
  lines.push("");

  lines.push("## 新增候选（未登记且未确认——按 docs/degradation-runbook.md 三选一处理）");
  if (fresh.length === 0) {
    lines.push("（无）");
  } else {
    for (const hit of fresh) {
      for (const match of hit.matches) {
        lines.push(`- \`${hit.path}:${match.line}\` [${match.id}] ${match.snippet}`);
      }
    }
  }
  lines.push("");

  lines.push("## 已确认项（candidates-baseline.yaml）");
  if (knownEntries.length === 0) {
    lines.push("（无）");
  } else {
    for (const entry of knownEntries) {
      lines.push(`- \`${entry.path}\` — ${entry.disposition} — ${entry.reason}`);
    }
  }
  lines.push("");

  lines.push("## 失效/冗余基线（--check 下失败）");
  if (stale.length === 0) {
    lines.push("（无）");
  } else {
    for (const entry of stale) {
      lines.push(`- \`${entry.path}\` — ${entry.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
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
  const { root, check, report } = parsed;

  let registryComponents;
  try {
    registryComponents = loadRegistryComponents(root);
  } catch (error) {
    console.error(`${LABEL}: ${error.message}`);
    return 2;
  }
  const baseline = loadBaseline(root);
  if (baseline.problems.length > 0) {
    console.error(`${LABEL}: candidates-baseline 违规（${baseline.problems.length} 处）：`);
    for (const problem of baseline.problems) console.error(`  ✗ ${problem}`);
    return 2;
  }
  const baselineByPath = new Map(baseline.entries.map(entry => [entry.path, entry]));

  const files = DEFAULT_ROOTS.flatMap(entry =>
    collectFiles(join(root, entry), [], new Set(SKIPPED_RELATIVE_DIRECTORIES.map(path => join(root, path)))),
  );
  const hits = new Map();
  for (const file of files) {
    const matches = scanFile(file);
    if (matches !== null) hits.set(relative(root, file).split(sep).join("/"), matches);
  }
  const hitPaths = [...hits.keys()].sort();

  const coveredPaths = hitPaths.filter(path => registryComponents.has(path));
  const knownEntries = [];
  const fresh = [];
  for (const path of hitPaths) {
    if (registryComponents.has(path)) continue;
    const entry = baselineByPath.get(path);
    if (entry !== undefined) knownEntries.push(entry);
    else fresh.push({ path, matches: hits.get(path) });
  }

  const stale = [];
  for (const entry of baseline.entries) {
    if (registryComponents.has(entry.path)) {
      stale.push({ path: entry.path, reason: "冗余基线：已被 registry 覆盖（registry 优先），请从基线移除" });
    } else if (!hits.has(entry.path)) {
      stale.push({ path: entry.path, reason: "不再命中：文件删除/改名或模式不再匹配——复核后移除" });
    }
  }

  const summary = `${LABEL}: 新增候选 ${fresh.length} / 已确认 ${knownEntries.length} / registry 覆盖 ${coveredPaths.length} / 命中 ${hits.size} / 扫描 ${files.length} / 失效基线 ${stale.length}`;
  const text = `${renderReport({ root, scanned: files.length, hits, coveredPaths, knownEntries, fresh, stale })}\n\n${summary}`;
  console.log(text);
  if (report !== null) {
    try {
      writeFileSync(resolve(root, report), `${text}\n`);
      console.log(`${LABEL}: 报告已写入 ${report}`);
    } catch (error) {
      console.error(`${LABEL}: 报告写入失败：${error.message}`);
      return 2;
    }
  }

  if (fresh.length > 0) {
    console.log(
      `${LABEL}: 新增候选 ${fresh.length} 个——补 registry 登记、记入 candidates-baseline 或修复模式（见 runbook）`,
    );
  }
  if (check && (fresh.length > 0 || stale.length > 0)) return 1;
  return 0;
}

process.exitCode = main();
