#!/usr/bin/env node
// audit-silent-catches.mjs
// 静默 catch 审计（供 docs/degradation-registry-plan.md 的 DoD 对账）。
//
// 背景：铁律 11「降级但不静默」。全仓曾用 `grep 'catch {}'` 做静默审计——实测零命中：
// 三类真实静默点（注释体 catch / `.catch(() => {})` / 仅计数 catch）都无法被该 pattern
// 匹配，是空转门禁。本脚本用「括号配对 + 可观测足迹/意图注释启发式」枚举候选并**分档**：
//
//   档 A「无注释且无足迹」——catch 语句行、上一行与函数体内均无注释，且无任何可观测足迹。
//   档 B「有注释但无运行时足迹」——有意图注释（沿用 measure-techdebt 的注释卫生口径），
//        但运行时零可观测足迹（注释说明意图 ≠ 运行时可观测）。
//
// 可观测足迹（命中任意一类即不算候选）：
//   - 日志：console / logger / .warn / .error / .info / .debug / .trace / log(
//   - 抛错：throw / reject(
//   - 诊断遥测：telemetry / diagnostic(s) / track / emit / report / onError / sentry
//   - 错误面呈给调用方：res.status( / res.json( / res.send( / reply.code( / reply.send(
//   - 块体内非空 return（表达式体回调无 return 概念）
//
// 范围对齐 `scripts/measure-techdebt.mjs` 的 catch 口径：src + ui/src + ui/server 产品代码，
// 排除 *.spec.* / *.test.*。与其「无注释无参 catch」的关系：本脚本是其**扩展**（含带参 catch
// 与 .catch 回调、含档 B 展示），计数**不设棘轮**——是否升级为门禁由计划 T6 决定。
//
// 本脚本只产出候选清单（默认 exit 0），供 DoD 与 registry 豁免逐项对账；不代替人工判定。
// 有意保留的启发式局限（防误报淹没信号）：不解析字符串/模板字面量内的括号与 `//`；
// 不解析回调引用形态（`.catch(onError)`）；不跨函数追踪。
//
// 用法：
//   node scripts/audit-silent-catches.mjs                # 审计（src / ui/src / ui/server）
//   node scripts/audit-silent-catches.mjs --root DIR     # 负控制测试指向 fixture 树
//   node scripts/audit-silent-catches.mjs --fail-on-hits # 有候选时 exit 1

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "audit-silent-catches";
const DEFAULT_ROOTS = ["src", "ui/src", "ui/server"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
const SPEC_FILE_PATTERN = /\.(?:spec|test)\.[^.]+$/;

/** 可观测足迹的词法类。命中任意一类即不算候选。 */
const OBSERVABILITY_PATTERNS = [
  /\bconsole\b/,
  /\blogger\b/,
  /\.(?:warn|error|info|debug|trace|log)\s*\(/,
  /\blog\s*\(/,
  /\bthrow\b/,
  /\breject\s*\(/,
  /\b(?:telemetry|diagnostics?|track|emit|report|sentry|onError)\b/i,
  /\bres\.(?:status|json|send)\s*\(/,
  /\breply\.(?:code|send)\s*\(/,
];
const RETURN_PATTERN = /\breturn\b/;
const COMMENT_PATTERN = /\/\/|\/\*/;

const USAGE = `用法：node scripts/audit-silent-catches.mjs [--root DIR] [--fail-on-hits]
  --root DIR      仓库根（默认由脚本位置推导；负控制测试用）
  --fail-on-hits  存在候选时 exit 1（默认 exit 0，仅输出清单）`;

function parseArgs(argv, defaultRoot) {
  let root = defaultRoot;
  let failOnHits = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) return { error: "--root 需要一个目录参数" };
      root = resolve(value);
      i += 1;
    } else if (arg === "--fail-on-hits") {
      failOnHits = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
    }
  }
  return { root, failOnHits };
}

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectFiles(join(dir, entry.name), out);
    } else if (EXTENSIONS.some(extension => entry.name.endsWith(extension)) && !SPEC_FILE_PATTERN.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** 从 index（指向开括号）起做配对，返回闭括号下标；找不到返回 -1。盲配：不解析字符串内括号。 */
function matchBracket(source, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;
const collapse = text => text.replace(/\s+/g, " ").trim();

/** 语句行、上一行（整行注释）或函数体内存在注释痕迹 = 有意图注释。 */
function hasIntentComment(source, siteIndex, body) {
  const lineStart = source.lastIndexOf("\n", siteIndex) + 1;
  const lineEndRaw = source.indexOf("\n", siteIndex);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  if (COMMENT_PATTERN.test(source.slice(lineStart, lineEnd))) return true;
  if (lineStart > 0) {
    const prevStart = source.lastIndexOf("\n", lineStart - 2) + 1;
    const prevLine = source.slice(prevStart, lineStart - 1);
    if (/^\s*(?:\/\/|\/\*|\*)/.test(prevLine)) return true;
  }
  return COMMENT_PATTERN.test(body);
}

function hasObservability(body, blockForm) {
  return OBSERVABILITY_PATTERNS.some(pattern => pattern.test(body)) || (blockForm && RETURN_PATTERN.test(body));
}

/** 收集单文件内的候选站点。 */
function scanFile(root, file) {
  const source = readFileSync(file, "utf8");
  const relativeFile = relative(root, file).split(sep).join("/");
  const hits = [];

  const record = (siteIndex, kind, body, blockForm) => {
    if (hasObservability(body, blockForm)) return;
    hits.push({
      file: relativeFile,
      line: lineOf(source, siteIndex),
      kind,
      tier: hasIntentComment(source, siteIndex, body) ? "B" : "A",
      snippet: collapse(body).slice(0, 60) || "（空体）",
    });
  };

  // 形态一：catch 子句（负向环视排除 `.catch(` 与标识符尾部）。
  const clausePattern = /(?<![.\w$])catch\s*(?:\([^)]*\)\s*)?\{/g;
  for (const match of source.matchAll(clausePattern)) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchBracket(source, openIndex, "{", "}");
    const body = closeIndex === -1 ? source.slice(openIndex + 1) : source.slice(openIndex + 1, closeIndex);
    record(match.index, "catch", body, true);
  }

  // 形态二：`.catch(` 回调。仅解析函数字面量（箭头 / function）；回调引用形态有意跳过。
  const callPattern = /\.catch\s*\(/g;
  for (const match of source.matchAll(callPattern)) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchBracket(source, openIndex, "(", ")");
    if (closeIndex === -1) continue;
    const argument = source.slice(openIndex + 1, closeIndex);
    const arrowIndex = argument.indexOf("=>");
    let body = null;
    let blockForm = false;
    if (arrowIndex !== -1) {
      const afterArrow = argument.slice(arrowIndex + 2).trimStart();
      if (afterArrow.startsWith("{")) {
        blockForm = true;
        const leadingWhitespace = argument.slice(arrowIndex + 2).length - afterArrow.length;
        const braceOffset = openIndex + 1 + arrowIndex + 2 + leadingWhitespace;
        const braceClose = matchBracket(source, braceOffset, "{", "}");
        body = braceClose === -1 ? source.slice(braceOffset + 1) : source.slice(braceOffset + 1, braceClose);
      } else {
        body = afterArrow;
      }
    } else if (/\bfunction\b/.test(argument)) {
      const braceOffset = openIndex + 1 + argument.indexOf("{");
      if (braceOffset >= openIndex + 1) {
        blockForm = true;
        const braceClose = matchBracket(source, braceOffset, "{", "}");
        body = braceClose === -1 ? source.slice(braceOffset + 1) : source.slice(braceOffset + 1, braceClose);
      }
    }
    if (body === null) continue;
    record(match.index, ".catch", body, blockForm);
  }

  return hits;
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
  const { root, failOnHits } = parsed;

  const files = DEFAULT_ROOTS.flatMap(entry => collectFiles(join(root, entry)));
  const hits = [];
  for (const file of files) {
    try {
      hits.push(...scanFile(root, file));
    } catch (error) {
      console.error(`${LABEL}: 读取失败（跳过）：${file}（${error.message}）`);
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const tierA = hits.filter(hit => hit.tier === "A").length;
  const tierB = hits.length - tierA;
  console.log(
    `${LABEL}: 候选 ${hits.length} 处（档 A 无注释且无足迹 ${tierA} / 档 B 有注释但无足迹 ${tierB}；扫描 ${files.length} 文件；根：${DEFAULT_ROOTS.join(", ")}）`,
  );
  for (const hit of hits) {
    console.log(
      `  ${hit.file}:${hit.line}  ${hit.kind}  [${hit.tier === "A" ? "无注释" : "已注释·无足迹"}]  ${hit.snippet}`,
    );
  }
  console.log(`  → 逐项与 registry 豁免/修复对账（docs/degradation-registry-plan.md DoD）；本清单不代替人工判定`);

  return failOnHits && hits.length > 0 ? 1 : 0;
}

process.exitCode = main();
