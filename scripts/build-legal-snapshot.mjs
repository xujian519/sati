#!/usr/bin/env node
/**
 * 构建离线法条快照（law_search 的兜底数据源）。
 *
 * 输入是 deepseek-harness `packages/legal/legal-law/assets/legal-law/`（MIT）
 * 下「一法一 YAML + manifest.json」的索引目录；输出是随包分发的紧凑快照：
 *
 *   assets/legal-snapshot/manifest.json          — 版本/时点/计数/许可/摘要
 *   assets/legal-snapshot/legal-articles.jsonl.gz — 一行一条 {法名, 文档名, 条号, 正文}
 *
 * 为什么不在运行期直接读 YAML：74 MB / 7911 个文件，解析成本与仓库体积都不可接受。
 * 为什么打包压缩而不是按需构建：CI 与终端用户没有源仓库，兜底必须在断网/无库时
 * 直接可用；gzip 是 Node 内置能力（node:zlib），不引入解压依赖。
 *
 * 用法：
 *   node scripts/build-legal-snapshot.mjs [源目录] [--transcripts 转录文件]
 *   源目录默认 $SATI_LEGAL_LAW_ASSETS，其次同级 deepseek-harness 路径。
 *   转录文件默认 $SATI_LEGAL_TRANSCRIPTS，其次 .cache/legal-transcribe/transcripts.jsonl.gz
 *   （由 `scripts/transcribe-legal-law.mjs` 从外部语料生成；缺失时只用 YAML 里已有的正文）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(REPO_ROOT, "assets", "legal-snapshot");
const OUT_JSONL = resolve(OUT_DIR, "legal-articles.jsonl.gz");
const OUT_MANIFEST = resolve(OUT_DIR, "manifest.json");

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

const DEFAULT_TRANSCRIPTS = join(REPO_ROOT, ".cache", "legal-transcribe", "transcripts.jsonl.gz");

/** 快照格式版本：字段含义变化时 +1，读端不匹配即拒绝（降级可见）。 */
const SNAPSHOT_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--transcripts") flags.transcripts = argv[++i];
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  return { positional, flags };
}

function pickSource(positional) {
  const fromArgv = positional[0];
  const fromEnv = process.env.SATI_LEGAL_LAW_ASSETS;
  const dir = fromArgv ?? fromEnv ?? DEFAULT_SOURCE;
  if (!existsSync(dir)) {
    throw new Error(`法条索引源目录不存在：${dir}（用参数或 SATI_LEGAL_LAW_ASSETS 指定）`);
  }
  return dir;
}

/** 转录 overlay：YAML 里没有正文的法，用外部语料补的稿子。缺失时不报错（只用 YAML 正文）。 */
function readTranscripts(explicitPath) {
  const path = explicitPath ?? process.env.SATI_LEGAL_TRANSCRIPTS ?? DEFAULT_TRANSCRIPTS;
  if (!existsSync(path)) return { path, available: false, rows: new Map() };
  const rows = new Map();
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (typeof row?.f === "string" && Array.isArray(row.a)) rows.set(row.f, row);
  }
  return { path, available: true, rows };
}

/** 从 manifest 取 [法名, 文档名, 文件名]；manifest 缺失时退回扫目录（law/document 从文件读）。 */
function readManifest(sourceDir) {
  const manifestPath = join(sourceDir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  const root = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(root?.laws)) throw new Error(`${manifestPath} 缺少 laws 数组`);
  return root.laws.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 3) throw new Error(`manifest 第 ${index + 1} 行不是三元组`);
    return { law: row[0], document: row[1], file: row[2] };
  });
}

function listYamlFiles(sourceDir) {
  return readdirSync(sourceDir)
    .filter(name => name.endsWith(".yaml"))
    .sort();
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const sourceDir = pickSource(positional);
  const manifest = readManifest(sourceDir);
  const files = manifest?.map(entry => entry.file) ?? listYamlFiles(sourceDir);
  const transcripts = readTranscripts(flags.transcripts);

  const lines = [];
  let lawCount = 0;
  let articleCount = 0;
  let overlayLawCount = 0;
  let overlayArticleCount = 0;
  const skipped = [];

  for (const file of files) {
    const path = join(sourceDir, file);
    let root;
    try {
      root = parseYaml(readFileSync(path, "utf8"));
    } catch (error) {
      // 坏文件不静默吞掉：计入 skipped 并在 manifest 里回报。
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const law = typeof root?.law === "string" ? root.law : undefined;
    const document = typeof root?.document === "string" ? root.document : undefined;
    if (law === undefined || document === undefined) {
      skipped.push({ file, reason: "缺少 law/document" });
      continue;
    }
    const articles = Array.isArray(root?.articles) ? root.articles : [];
    if (articles.length === 0) {
      skipped.push({ file, reason: "未声明 article" });
      continue;
    }
    // 紧凑字段名（n/d/a/t）压缩体积；语义见读端 types.ts。
    let rows = [];
    for (const article of articles) {
      const number = typeof article?.article === "number" ? article.article : undefined;
      const text = typeof article?.text === "string" && article.text.trim() !== "" ? article.text : undefined;
      if (number === undefined || text === undefined) continue;
      rows.push([number, text]);
    }
    // 逐条转录出处：同法内一致时提到法级（s=sourceDoc, v=verifiedOn），
    // 不一致则不下法级断言（读端视为「混合来源」，不再声称统一出处）。
    const sourceDocs = new Set(articles.map(article => article?.sourceDoc).filter(value => typeof value === "string"));
    const verifiedOns = new Set(
      articles.map(article => article?.verifiedOn).filter(value => typeof value === "string"),
    );
    let provenance = {
      ...(sourceDocs.size === 1 ? { s: [...sourceDocs][0] } : {}),
      ...(verifiedOns.size === 1 ? { v: [...verifiedOns][0] } : {}),
    };
    if (rows.length === 0) {
      const overlay = transcripts.rows.get(file);
      const overlayRows = Array.isArray(overlay?.a)
        ? overlay.a.filter(pair => Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "string")
        : [];
      if (overlayRows.length === 0) {
        skipped.push({
          file,
          reason: transcripts.available ? "无正文：YAML 与转录 overlay 都没有" : "无可用条文正文（text 为空）",
        });
        continue;
      }
      rows = overlayRows;
      provenance = {
        ...(typeof overlay.s === "string" ? { s: overlay.s } : {}),
        ...(typeof overlay.v === "string" ? { v: overlay.v } : {}),
      };
      overlayLawCount += 1;
      overlayArticleCount += rows.length;
    }
    lawCount += 1;
    articleCount += rows.length;
    lines.push(JSON.stringify({ n: law, d: document, ...provenance, a: rows }));
  }

  const content = lines.length === 0 ? "" : lines.join("\n") + "\n";
  const gz = gzipSync(Buffer.from(content, "utf8"), { level: 9 });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSONL, gz);

  const sha256 = createHash("sha256").update(gz).digest("hex");
  const snapshotAt = new Date().toISOString().slice(0, 10);
  const skippedReasons = {};
  for (const entry of skipped) skippedReasons[entry.reason] = (skippedReasons[entry.reason] ?? 0) + 1;
  const snapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotAt,
    source: transcripts.available
      ? "deepseek-harness packages/legal/legal-law/assets/legal-law + .cache/legal-transcribe（外部语料转录）"
      : "deepseek-harness packages/legal/legal-law/assets/legal-law",
    license: "MIT（源包）；法律文本依《著作权法》第五条不受著作权保护",
    format: "gzip-jsonl（一行一法：{n:法名,d:文档名,a:[[条号,正文]]}）",
    file: "legal-articles.jsonl.gz",
    lawCount,
    articleCount,
    byteSize: gz.byteLength,
    sha256,
    // 补转录的覆盖率：overlay 是否存在、补了多少部/多少条，避免把「只剩 2 部缺正文」
    // 误读成「全部来自上游 YAML」。缺 overlay 时这两个计数为 0 且 available=false。
    transcripts: {
      available: transcripts.available,
      lawCount: overlayLawCount,
      articleCount: overlayArticleCount,
    },
    // 依次文件清单会让 manifest 涨到 1MB 级（只剩 2 个缺口时也不会，但仍只留统计与样例）。
    skipped: { count: skipped.length, reasons: skippedReasons, samples: skipped.slice(0, 5) },
  };
  writeFileSync(OUT_MANIFEST, JSON.stringify(snapshotManifest, null, 2) + "\n");

  console.log(
    `legal snapshot: laws=${lawCount} articles=${articleCount} gz=${(gz.byteLength / 1024 / 1024).toFixed(2)}MB overlayLaws=${overlayLawCount} skipped=${skipped.length} -> ${OUT_DIR}`,
  );
  if (skipped.length > 0) console.log("skipped:", JSON.stringify(skipped.slice(0, 5)));
}

main();
