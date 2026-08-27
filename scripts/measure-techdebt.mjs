#!/usr/bin/env node
/**
 * Sati 技术债务指标度量脚本（只读、幂等）。
 *
 * 用法：
 *   node scripts/measure-techdebt.mjs --json          # 输出 JSON（默认）
 *   node scripts/measure-techdebt.mjs --update <path> # 写入/刷新 metrics.md
 *
 * 覆盖指标：
 *   - 体积/复杂度：目录文件数/行数、Top 大文件、TS AST 单函数行数（god function）
 *   - 类型安全    ：any / @ts-expect-error / @ts-ignore（按模块聚合）
 *   - 错误&可观测 ：裸 console.*、空 catch、无参 catch、TODO/HACK/FIXME/XXX
 *   - 分层边界    ：ui/server→src 深层导入、src→ui 导入、ui/server 直连 edgeclaw lib 编译产物
 *   - 测试        ：各 src 模块测试文件数、零/极薄模块
 *   - i18n        ：en / zh-CN 命名空间 key 对齐
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".pnpm-store",
  "coverage",
  ".git",
  ".reasonix",
  ".qoder",
  ".codegraph",
  "test-results",
  "lib",
  "ui-source",
]);

const GOD_FN_THRESHOLD = Number(process.env.GOD_FN_THRESHOLD ?? 300);
const TOP_FILES_LIMIT = Number(process.env.TOP_FILES_LIMIT ?? 30);

// 只匹配「真实类型逃逸」的 any 形态（: any / as any / <any> / any[]），
// 避免把注释/字符串里的英文单词 "any" 误计。@ts-expect-error / @ts-ignore 单独计。
const UNSAFE_PATTERN = /: any\b|as any\b|<any>|any\[\]|@ts-expect-error|@ts-ignore/g;
const CONSOLE_PATTERN = /console\.(log|error|warn|info|debug)/g;
const EMPTY_CATCH_PATTERN = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
const NO_PARAM_CATCH_PATTERN = /\bcatch\s*\{/g;
const SWALLOW_CATCH_PATTERN = /catch\s*(\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/)|[ \t\r\n])*\}/g;
const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

let ts = null;

async function initTs() {
  if (ts) return ts;
  const mod = await import("typescript");
  ts = mod.default ?? mod;
  return ts;
}

function listFiles(dir, exts) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = d => {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (exts.some(x => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function countLines(files) {
  return files.reduce((acc, f) => acc + readLines(f).length, 0);
}

function topFiles(files, limit) {
  return files
    .map(f => ({ file: relative(ROOT, f), lines: readLines(f).length }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, limit);
}

/** 用 TS compiler API 找单函数超过阈值的 god function。 */
async function godFunctions(files) {
  const t = await initTs();
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
    const src = readFileSync(f, "utf8");
    const kind = f.endsWith(".tsx") ? t.ScriptKind.TSX : t.ScriptKind.TS;
    const rel = relative(ROOT, f);
    const sf = t.createSourceFile(rel, src, t.ScriptTarget.Latest, true, kind);
    const walk = (node, varHint) => {
      if (!node) return;
      let isFn = false;
      let name = null;
      let kindName = "fn";
      if (t.isFunctionDeclaration(node)) {
        isFn = true;
        name = node.name?.text ?? "(anonymous)";
        kindName = "function";
      } else if (t.isMethodDeclaration(node)) {
        isFn = true;
        name = node.name?.getText(sf) ?? "(anonymous)";
        kindName = "method";
      } else if (t.isFunctionExpression(node)) {
        isFn = true;
        name = node.name?.text ?? varHint ?? "(anonymous)";
        kindName = "expression";
      } else if (t.isArrowFunction(node)) {
        isFn = true;
        name = varHint ?? "(anonymous)";
        kindName = "arrow";
      }
      if (isFn) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const len = end - start + 1;
        if (len >= GOD_FN_THRESHOLD) {
          result.push({ file: rel, name, line: start, length: len, kind: kindName });
        }
      }
      if (t.isVariableDeclaration(node)) {
        const declName = node.name?.getText(sf);
        t.forEachChild(node, c => walk(c, declName));
      } else {
        t.forEachChild(node, c => walk(c, null));
      }
    };
    walk(sf, null);
  }
  return result.sort((a, b) => b.length - a.length);
}

function moduleOf(file) {
  const parts = relative(ROOT, file).split("/");
  if (parts[0] === "src" && parts[1]) return parts[1];
  if (parts[0] === "ui" && parts[1]) return "ui/" + parts[1];
  if (parts[0] === "tests") return "tests";
  if (parts[0] === "scripts") return "scripts";
  return parts[0] ?? "?";
}

function grepCountByModule(files, pattern) {
  const perModule = {};
  let total = 0;
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const matches = src.match(pattern);
    const c = matches ? matches.length : 0;
    if (c === 0) continue;
    total += c;
    const mod = moduleOf(f);
    perModule[mod] = (perModule[mod] ?? 0) + c;
  }
  return { total, perModule };
}

/** 检测 ui/server→src 深层导入、src→ui 导入、edgeclaw 编译产物导入。 */
function boundaryChecks() {
  const uiServerFiles = listFiles(join(ROOT, "ui/server"), [".js", ".mjs", ".ts"]);
  const srcFiles = listFiles(join(ROOT, "src"), [".ts", ".tsx"]);
  const collect = (files, re) => {
    const out = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split("\n").length;
        out.push({ file: relative(ROOT, f), line, match: m[0].trim() });
      }
    }
    return out;
  };
  const uiServerToSrc = collect(uiServerFiles, /from\s+['"]\s*(\.\.\/)+src\//g);
  const srcToUi = collect(srcFiles, /from\s+['"][^'"]*(?:\/ui\/|@\/ui)/g);
  const edgeclawLib = collect(uiServerFiles, /from\s+['"][^'"]*edgeclaw-memory-core\/lib\//g);
  return {
    uiServerToSrcCount: uiServerToSrc.length,
    uiServerToSrcDeepImports: uiServerToSrc,
    srcToUiCount: srcToUi.length,
    srcToUiImports: srcToUi,
    edgeclawLibCount: edgeclawLib.length,
    edgeclawLibCompiledImports: edgeclawLib,
  };
}

function testCoverage() {
  const srcDirs = readdirSync(join(ROOT, "src"), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const perModule = {};
  for (const m of srcDirs) {
    const testDir = join(ROOT, "tests", m);
    if (existsSync(testDir)) {
      const c = listFiles(testDir, [".spec.ts", ".test.ts"]).length;
      if (c > 0) perModule[m] = c;
    }
  }
  return {
    perModule: Object.fromEntries(Object.entries(perModule).sort((a, b) => b[1] - a[1])),
    total: Object.values(perModule).reduce((a, b) => a + b, 0),
  };
}

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys.push(...flattenKeys(v, key));
    else keys.push(key);
  }
  return keys;
}

function i18nDiff() {
  const enDir = join(ROOT, "ui/src/i18n/locales/en");
  const zhDir = join(ROOT, "ui/src/i18n/locales/zh-CN");
  if (!existsSync(enDir) || !existsSync(zhDir)) return null;
  const out = [];
  for (const name of readdirSync(enDir).filter(x => x.endsWith(".json"))) {
    const enPath = join(enDir, name);
    const zhPath = join(zhDir, name);
    if (!existsSync(zhPath)) continue;
    const en = JSON.parse(readFileSync(enPath, "utf8"));
    const zh = JSON.parse(readFileSync(zhPath, "utf8"));
    const enKeys = new Set(flattenKeys(en));
    const zhKeys = new Set(flattenKeys(zh));
    out.push({
      namespace: name.replace(/\.json$/, ""),
      enKeys: enKeys.size,
      zhKeys: zhKeys.size,
      missingZh: [...enKeys].filter(k => !zhKeys.has(k)).length,
      missingEn: [...zhKeys].filter(k => !enKeys.has(k)).length,
    });
  }
  return { namespaces: out.map(x => x.namespace), namespacesDetails: out };
}

// 知识卡逐字节重复检测：按内容哈希分组 wiki 下全部 md。
// 背景：TD-KNOWLEDGE-N08（2026-08-27）曾出现整棵嵌套重复目录树（205 个文件逐字节相同），
// 该指标用于防止复发——组数/重复文件数/重复字节数任一非零即值得人工下钻。
function knowledgeDupMd() {
  const wikiRoot = join(ROOT, "src", "knowledge", "patent", "wiki");
  if (!existsSync(wikiRoot)) return { groups: 0, files: 0, bytes: 0 };
  const byHash = new Map();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) {
        const buf = readFileSync(p);
        const h = createHash("sha256").update(buf).digest("hex");
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(p);
      }
    }
  };
  walk(wikiRoot);
  let groups = 0;
  let files = 0;
  let bytes = 0;
  for (const paths of byHash.values()) {
    if (paths.length < 2) continue;
    groups += 1;
    // 记「冗余份数」：每组可删的最小副本数（n-1），体积同比例计
    const sorted = paths.sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const dup of sorted.slice(1)) {
      files += 1;
      bytes += readFileSync(dup).length;
    }
  }
  return { groups, files, bytes };
}

async function measure() {
  const srcFiles = listFiles(join(ROOT, "src"), [".ts", ".tsx"]);
  const srcJsFiles = listFiles(join(ROOT, "src"), [".js", ".jsx", ".mjs", ".cjs"]);
  const testsFiles = listFiles(join(ROOT, "tests"), [".ts", ".tsx", ".js"]);
  const uiSrcFiles = listFiles(join(ROOT, "ui/src"), [".ts", ".tsx"]);
  const uiServerFiles = listFiles(join(ROOT, "ui/server"), [".js", ".mjs", ".ts"]);

  const allSrcForScan = [...srcFiles, ...srcJsFiles];

  return {
    date: new Date().toISOString().slice(0, 10),
    stats: {
      srcTsFiles: srcFiles.length,
      srcTsLines: countLines(srcFiles),
      srcJsFiles: srcJsFiles.length,
      testsFiles: testsFiles.length,
      uiSrcFiles: uiSrcFiles.length,
      uiSrcLines: countLines(uiSrcFiles),
      uiServerFiles: uiServerFiles.length,
      uiServerLines: countLines(uiServerFiles),
    },
    topFiles: topFiles([...srcFiles, ...uiSrcFiles, ...uiServerFiles], TOP_FILES_LIMIT),
    godFunctions: {
      threshold: GOD_FN_THRESHOLD,
      count: 0,
      items: [],
    },
    unsafe: grepCountByModule(allSrcForScan, UNSAFE_PATTERN),
    console: grepCountByModule(allSrcForScan, CONSOLE_PATTERN),
    catchEmpty: grepCountByModule(allSrcForScan, EMPTY_CATCH_PATTERN),
    catchNoParam: grepCountByModule(allSrcForScan, NO_PARAM_CATCH_PATTERN),
    catchSilent: grepCountByModule(allSrcForScan, SWALLOW_CATCH_PATTERN),
    todos: grepCountByModule(allSrcForScan, TODO_PATTERN),
    boundaries: boundaryChecks(),
    tests: testCoverage(),
    i18n: i18nDiff(),
    knowledgeDupMd: knowledgeDupMd(),
  };
}

function topModules(perModule, n = 3) {
  const entries = Object.entries(perModule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
  if (entries.length === 0) return "—";
  return entries.map(([m, c]) => `${m}(${c})`).join(" · ");
}

function renderMarkdown(m) {
  const L = [];
  L.push(`# Sati 技术债务指标基线与趋势`);
  L.push(``);
  L.push(`> 由 \`node scripts/measure-techdebt.mjs --update\` 自动生成，谨防手工编辑。`);
  L.push(`> 最近一次快照：**${m.date}**`);
  L.push(``);
  L.push(`## 规模`);
  L.push(``);
  L.push(`| 维度 | 值 |`);
  L.push(`|---|---|`);
  L.push(`| src TS 文件 / 行数 | ${m.stats.srcTsFiles} / ${m.stats.srcTsLines} |`);
  L.push(`| src JS 文件 | ${m.stats.srcJsFiles} |`);
  L.push(`| tests 文件 | ${m.stats.testsFiles} |`);
  L.push(`| ui/src 文件 / 行数 | ${m.stats.uiSrcFiles} / ${m.stats.uiSrcLines} |`);
  L.push(`| ui/server 文件 / 行数 | ${m.stats.uiServerFiles} / ${m.stats.uiServerLines} |`);
  L.push(``);
  L.push(`## 异味指标（越少越好）`);
  L.push(``);
  L.push(`| 指标 | 总量 | 热点模块 |`);
  L.push(`|---|---|---|`);
  L.push(`| \`any\`/\`@ts-expect-error\`/\`@ts-ignore\` | ${m.unsafe.total} | ${topModules(m.unsafe.perModule)} |`);
  L.push(`| 裸 \`console.*\` | ${m.console.total} | ${topModules(m.console.perModule)} |`);
  L.push(`| 空 \`catch {}\` | ${m.catchEmpty.total} | ${topModules(m.catchEmpty.perModule)} |`);
  L.push(`| 静默吞错 \`catch\`（体仅注释/空白） | ${m.catchSilent.total} | ${topModules(m.catchSilent.perModule)} |`);
  L.push(`| 无参 \`catch {\` | ${m.catchNoParam.total} | ${topModules(m.catchNoParam.perModule)} |`);
  L.push(`| \`TODO/HACK/FIXME/XXX\` | ${m.todos.total} | ${topModules(m.todos.perModule)} |`);
  L.push(`| 分层违规 \`ui/server→src\` | ${m.boundaries.uiServerToSrcCount} | — |`);
  L.push(`| 分层违规 \`src→ui\` | ${m.boundaries.srcToUiCount} | — |`);
  L.push(`| edgeclaw \`lib\` 编译产物直连 | ${m.boundaries.edgeclawLibCount} | — |`);
  L.push(
    `| 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | ${m.knowledgeDupMd.groups} 组 · ${m.knowledgeDupMd.files} 文件 · ${m.knowledgeDupMd.bytes} B | — |`,
  );
  L.push(``);
  L.push(`## God function（单函数 ≥ ${m.godFunctions.threshold} 行）`);
  L.push(``);
  if (m.godFunctions.items.length === 0) L.push(`无。`);
  else {
    L.push(`| 文件 | 函数 | 行 | 类型 |`);
    L.push(`|---|---|---|---|`);
    for (const g of m.godFunctions.items) L.push(`| \`${g.file}\` | \`${g.name}\` | ${g.length} | ${g.kind} |`);
  }
  L.push(``);
  L.push(`## Top ${m.topFiles.length} 大文件`);
  L.push(``);
  L.push(`| 文件 | 行 |`);
  L.push(`|---|---|`);
  for (const f of m.topFiles) L.push(`| \`${f.file}\` | ${f.lines} |`);
  L.push(``);
  L.push(`## 测试覆盖（tests/<模块> 文件数）`);
  L.push(``);
  L.push(`| 模块 | 测试文件 |`);
  L.push(`|---|---|`);
  for (const [mod, c] of Object.entries(m.tests.perModule)) L.push(`| ${mod} | ${c} |`);
  L.push(``);
  L.push(`| **合计** | **${m.tests.total}** |`);
  L.push(``);
  if (m.i18n) {
    L.push(`## i18n en/zh-CN 对齐`);
    L.push(``);
    L.push(`| namespace | en keys | zh keys | 缺 zh | 缺 en |`);
    L.push(`|---|---|---|---|---|`);
    for (const ns of m.i18n.namespacesDetails)
      L.push(`| ${ns.namespace} | ${ns.enKeys} | ${ns.zhKeys} | ${ns.missingZh} | ${ns.missingEn} |`);
    L.push(``);
  }
  return L.join("\n");
}

function writeIf(args, content) {
  const idx = args.indexOf("--update");
  if (idx === -1) return false;
  const path = args[idx + 1];
  if (!path) {
    console.error("--update 需要目标路径参数");
    process.exit(2);
  }
  const full = path.startsWith("/") ? path : join(ROOT, path);
  let existing = "";
  if (existsSync(full)) existing = readFileSync(full, "utf8");
  const history = extractHistory(existing);
  const doc = `${content}\n\n## 历史快照\n\n${history}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, doc, "utf8");
  return true;
}

function extractHistory(existing) {
  const idx = existing.indexOf("## 历史快照");
  if (idx === -1) return "";
  return existing.slice(idx + "## 历史快照".length).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const m = await measure();
  const allSrcAndUi = [
    ...listFiles(join(ROOT, "src"), [".ts", ".tsx"]),
    ...listFiles(join(ROOT, "ui/src"), [".ts", ".tsx"]),
  ];
  const god = await godFunctions(allSrcAndUi);
  m.godFunctions = { threshold: GOD_FN_THRESHOLD, count: god.length, items: god };

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    return;
  }
  const md = renderMarkdown(m);
  if (writeIf(args, md)) {
    console.log(`metrics 已写入 ${args[args.indexOf("--update") + 1]}`);
    return;
  }
  process.stdout.write(md + "\n");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
