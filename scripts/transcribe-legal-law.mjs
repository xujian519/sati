#!/usr/bin/env node
/**
 * 从上游语料补转录法条正文，产出 Sati 侧的 overlay（不写上游仓库）。
 *
 * 背景：上游 `packages/legal/legal-law/assets/legal-law/` 的 7910 个 YAML 里，
 * 7893 个只有条号与 topic、没有正文（`text: null`）。每个 YAML 的文件头都记着
 * 它由哪份语料生成（`# 源文件：xxx(日期).md`），而语料就在本机另一份上游语料库
 * （默认 `~/projects/宝宸知识库_Raw/Laws-1.0.0`）里。本脚本按文件名精确对回语料，
 * 解析「第X条」段落，产出构建输入：
 *
 *   .cache/legal-transcribe/transcripts.jsonl.gz      — 一行一法 {f,n,d,s,v,a:[[条号,正文]]}
 *   .cache/legal-transcribe/transcripts-manifest.json — 时点/计数/失败原因/摘要
 *
 * 再由 `scripts/build-legal-snapshot.mjs` 把它与上游 YAML 合并成随包分发的
 * `assets/legal-snapshot/`（离线兜底的唯一运行时资产）。
 *
 * 为什么不回写上游 YAML：那是一次跨仓库、7893 个文件的大规模改写，且上游资产是
 * 发布产物；Sati 只需要一份可审计的 overlay，构建快照时覆盖合并即可（见
 * `scripts/build-legal-snapshot.mjs`）。上游保持只读，双方都可独立升级。
 *
 * 为什么不线上抓取：国家法律法规数据库（flk.npc.gov.cn）对批量访问会触发 WAF 的
 * JS 挑战（实测 20 部后整站返回挑战页），而本地语料与 YAML 的 revision 日期一一
 * 对应，既无限流风险，也能精确还原「当时那一版」。
 *
 * 语义与边界：
 * - 只在「解析出的条号覆盖 YAML 期望条号 ≥ 90%」时收录，否则整部跳过并记原因
 *   （防止把目录、修正决定里的条号误当成正文，或拿错版本的稿子）；
 * - 找不到源语料、YAML 损坏都显式记录，不静默当成功；
 * - 已收录过的法（overlay 里已有）默认跳过，可断点续跑；`--force` 重算全部。
 *
 * 用法：
 *   node scripts/transcribe-legal-law.mjs [源目录] [--corpus 语料根] [--limit N] [--filter 子串] [--force]
 * 源目录默认 $SATI_LEGAL_LAW_ASSETS，其次同级 deepseek-harness 路径。
 * 语料根默认 $SATI_LEGAL_SOURCE_CORPUS，其次 ~/projects/宝宸知识库_Raw/Laws-1.0.0。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 转录结果是「由外部语料派生的构建输入」，不是可分发资产：落在 .cache（已 gitignore），
// 由 build-legal-snapshot.mjs 合并进随包分发的 assets/legal-snapshot。
const OUT_DIR = resolve(REPO_ROOT, ".cache", "legal-transcribe");
const OUT_JSONL = resolve(OUT_DIR, "transcripts.jsonl.gz");
const OUT_MANIFEST = resolve(OUT_DIR, "transcripts-manifest.json");
const RESULTS_PATH = resolve(OUT_DIR, "results.jsonl");

const DEFAULT_SOURCE = join(
  REPO_ROOT,
  "..",
  "deepseek-harness",
  "packages",
  "legal",
  "legal-law",
  "assets",
  "legal-law",
);
const DEFAULT_CORPUS = join(homedir(), "projects", "宝宸知识库_Raw", "Laws-1.0.0");

function parseArgs(argv) {
  const positional = [];
  const flags = {
    limit: Number.POSITIVE_INFINITY,
    filter: undefined,
    force: false,
    corpus: process.env.SATI_LEGAL_SOURCE_CORPUS ?? DEFAULT_CORPUS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") flags.limit = Number(argv[++i]);
    else if (arg === "--filter") flags.filter = argv[++i];
    else if (arg === "--corpus") flags.corpus = argv[++i];
    else if (arg === "--force") flags.force = true;
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  const dir = positional[0] ?? process.env.SATI_LEGAL_LAW_ASSETS ?? DEFAULT_SOURCE;
  if (!existsSync(dir)) throw new Error(`法条索引源目录不存在：${dir}`);
  if (!existsSync(flags.corpus)) throw new Error(`法条语料根不存在：${flags.corpus}（用 --corpus 指定）`);
  return { dir, ...flags };
}

/** 语料库按「文件名」索引：YAML 注释里的源文件名是唯一的、不含目录。 */
function buildCorpusIndex(root) {
  const index = new Map();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) index.set(entry.name, path);
    }
  };
  walk(root);
  return index;
}

/** 已产出的 overlay：按 YAML 文件名索引，便于断点续跑。 */
function readExistingOverlay() {
  const map = new Map();
  if (!existsSync(OUT_JSONL)) return map;
  try {
    const text = gunzipSync(readFileSync(OUT_JSONL)).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line);
      if (typeof row?.f === "string") map.set(row.f, row);
    }
  } catch (error) {
    console.warn(`现有 overlay 不可读，忽略并重建：${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
  return map;
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 中文数字转整数（覆盖「一」到「九百九十九」；条号不会更大）。 */
function chineseToNumber(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  let total = 0;
  // unit 是「还没被单位吸收的数字」；0 表示当前没有待吸收的数字。
  // 不能用 1 当哨兵，否则「一」会被算成 0。
  let unit = 0;
  for (const ch of text) {
    if (CN_UNITS[ch] !== undefined) {
      total += (unit === 0 ? 1 : unit) * CN_UNITS[ch];
      unit = 0;
    } else if (CN_DIGITS[ch] !== undefined) {
      unit = CN_DIGITS[ch];
    } else {
      return undefined;
    }
  }
  return total + unit;
}

const ARTICLE_HEAD = /^第([一二三四五六七八九十百千零〇两0-9]+)条[\s\u3000:：]/u;
const CHAPTER_HEAD = /^第[一二三四五六七八九十百千零〇0-9]+[章节][\s\u3000]/u;

/** 「第X条」开头的行 → 条号 + 去掉前缀后的正文首行；不是则 undefined。 */
function readArticleHead(line) {
  const match = line.match(ARTICLE_HEAD);
  if (match === null) return undefined;
  const number = chineseToNumber(match[1]);
  if (number === undefined) return undefined;
  const rest = line.slice(match[0].length).trim();
  return { number, rest };
}

/** 从语料 markdown 切出「条号 → 正文」。 */
function splitArticles(markdown) {
  const articles = new Map();
  let current;
  const flush = () => {
    if (current && current.lines.length > 0) {
      const text = current.lines.join("\n").trim();
      if (text !== "" && !articles.has(current.number)) articles.set(current.number, text);
    }
    current = undefined;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\u3000/gu, " ").trim();
    if (line === "" || line.startsWith("<!--")) continue;
    if (line.startsWith("#")) {
      // 标题行（含目录里的章节名）不入正文；也借此断开跨章串行。
      flush();
      continue;
    }
    const head = readArticleHead(line);
    if (head !== undefined) {
      flush();
      current = { number: head.number, lines: head.rest === "" ? [] : [head.rest] };
      continue;
    }
    if (CHAPTER_HEAD.test(line)) {
      flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return articles;
}

const SOURCE_COMMENT = /^# 源文件：(.+\.md)$/mu;

/** 转录一部法；成功返回 overlay 行（含 f/n/d/s/v/a），失败返回带 status 的原因。 */
function transcribeOne(corpusIndex, file, path) {
  const source = readFileSync(path, "utf8");
  const sourceDoc = source.match(SOURCE_COMMENT)?.[1];
  if (sourceDoc === undefined) return { file, status: "no-source-comment" };
  const corpusPath = corpusIndex.get(sourceDoc);
  if (corpusPath === undefined) return { file, status: "no-corpus", sourceDoc };
  let root;
  try {
    root = parseYaml(source);
  } catch (error) {
    return { file, status: "bad-yaml", reason: String(error?.message ?? error) };
  }
  const law = typeof root?.law === "string" ? root.law : undefined;
  const document = typeof root?.document === "string" ? root.document : undefined;
  if (law === undefined || document === undefined) return { file, status: "missing-law" };
  const expected = (Array.isArray(root?.articles) ? root.articles : [])
    .map(entry => (typeof entry?.article === "number" ? entry.article : undefined))
    .filter(value => value !== undefined);
  if (expected.length === 0) return { file, status: "missing-articles" };

  const texts = splitArticles(readFileSync(corpusPath, "utf8"));
  const covered = expected.filter(number => texts.has(number));
  const coverage = covered.length / expected.length;
  if (coverage < 0.9) {
    return {
      file,
      status: "mismatch",
      sourceDoc,
      expected: expected.length,
      parsed: texts.size,
      covered: covered.length,
      coverage: Number(coverage.toFixed(3)),
    };
  }

  const rows = expected.filter(number => texts.has(number)).map(number => [number, texts.get(number)]);
  return {
    file,
    status: "ok",
    sourceDoc,
    expected: expected.length,
    covered: rows.length,
    row: {
      f: file,
      n: law,
      d: document,
      s: sourceDoc,
      v: new Date().toISOString().slice(0, 10),
      a: rows,
    },
  };
}

function main() {
  const { dir, corpus, limit, filter, force } = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(RESULTS_PATH, { force: true });
  const corpusIndex = buildCorpusIndex(corpus);
  const existing = force ? new Map() : readExistingOverlay();
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".yaml"))
    .filter(name => (filter === undefined ? true : name.includes(filter)))
    .sort();

  const pending = files.filter(file => {
    const source = readFileSync(join(dir, file), "utf8");
    return source.includes("text: null") && !existing.has(file);
  });
  const total = Math.min(pending.length, Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY);
  console.log(
    `待转录 ${pending.length} 部（共 ${files.length} 个 YAML，语料 ${corpusIndex.size} 份，已有 overlay ${existing.size} 部）`,
  );

  const counters = {};
  const overlay = new Map(existing);
  const startedAt = Date.now();
  let processed = 0;
  for (const file of pending) {
    let result;
    try {
      result = transcribeOne(corpusIndex, file, join(dir, file));
    } catch (error) {
      result = { file, status: "error", reason: String(error?.message ?? error) };
    }
    counters[result.status] = (counters[result.status] ?? 0) + 1;
    if (result.status === "ok") {
      overlay.set(file, result.row);
      delete result.row;
    }
    appendFileSync(RESULTS_PATH, JSON.stringify(result) + "\n");
    processed += 1;
    if (processed % 500 === 0 || processed === total) {
      const rate = processed / ((Date.now() - startedAt) / 1000);
      console.log(`[${processed}/${total}] ${rate.toFixed(1)} 部/秒 ${JSON.stringify(counters)}`);
    }
    if (processed >= total) break;
  }

  const rows = [...overlay.values()];
  const articleCount = rows.reduce((sum, row) => sum + row.a.length, 0);
  const content = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(content, "utf8"), { level: 9 });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSONL, gz);

  const countersReasons = {};
  for (const [status, count] of Object.entries(counters)) {
    countersReasons[status] = count;
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString().slice(0, 10),
    corpusRoot: corpus,
    corpusFileCount: corpusIndex.size,
    yamlFiles: files.length,
    transcribedLaws: rows.length,
    transcribedArticles: articleCount,
    byteSize: gz.byteLength,
    sha256: createHash("sha256").update(gz).digest("hex"),
    lastRun: { pendingAtStart: pending.length, processed, counters: countersReasons },
    failures: readFailuresSummary(),
  };
  writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `overlay: laws=${rows.length} articles=${articleCount} gz=${(gz.byteLength / 1024 / 1024).toFixed(2)}MB -> ${OUT_DIR}`,
  );
}

/** 把本次失败的逐条原因汇总成 manifest 里的统计与样例。 */
function readFailuresSummary() {
  const failures = [];
  for (const line of readFileSync(RESULTS_PATH, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const result = JSON.parse(line);
    if (result.status !== "ok")
      failures.push({ file: result.file, status: result.status, sourceDoc: result.sourceDoc });
  }
  const reasons = {};
  for (const failure of failures) reasons[failure.status] = (reasons[failure.status] ?? 0) + 1;
  return { count: failures.length, reasons, samples: failures.slice(0, 5) };
}

main();
