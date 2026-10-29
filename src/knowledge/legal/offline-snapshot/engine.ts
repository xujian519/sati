/**
 * 离线法条快照引擎（law_search 兜底）。
 *
 * 设计要点：
 * - **只读、只加载一次**：首次查询时才 gunzip + 解析 JSONL；在线库可用时永不加载
 *   （降级路径的冷启动成本不摊到正常路径）。
 * - **不做超出数据的声称**：快照没有施行日/失效字段，`asOf` 时点检索返回
 *   `timeFilter: "unsupported"` 且不按日期过滤；`level` / `category` 过滤同样不支持，
 *   由工具层把 `unsupportedFilters` 回传给模型（降级可见，不静默忽略）。
 * - 检索为线性匹配（17 部法 / 3591 条、未压缩 ~10MB 量级），不建 FTS 索引：
 *   兜底路径追求「零外部依赖、可直接解压即用」，不追求与在线库同等的排序质量。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractLawKeywords } from "../keywords.js";
import type {
  LawCategory,
  LawRecord,
  LawSearchResult,
  LegalSearchSource,
  LegalTimeFilter,
  TimedLegalSearchResult,
} from "../types.js";
import {
  LEGAL_SNAPSHOT_DATA_FILE,
  LEGAL_SNAPSHOT_MANIFEST_FILE,
  LEGAL_SNAPSHOT_SCHEMA_VERSION,
  LegalSnapshotError,
  type LegalSnapshotLaw,
  type LegalSnapshotManifest,
} from "./types.js";

/** 离线快照不支持的过滤维度（工具层把它回传，避免模型误以为已过滤）。 */
export const SNAPSHOT_UNSUPPORTED_FILTERS = ["level", "category"] as const;

/** 单次查询最多物化的命中条数（工具层还会按法律名配额再截断）。 */
const MAX_MATCHES = 200;

/** 名称命中时拼接正文的上限（工具层另有 4000 字截断，这里避免无谓的大字符串）。 */
const MAX_JOINED_CHARS = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(dir: string): LegalSnapshotManifest {
  const path = join(dir, LEGAL_SNAPSHOT_MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new LegalSnapshotError(`离线法条快照清单缺失：${path}`);
  }
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LegalSnapshotError(`离线法条快照清单不是合法 JSON：${path}（${(error as Error).message}）`);
  }
  if (!isRecord(root)) throw new LegalSnapshotError(`离线法条快照清单必须是对象：${path}`);
  const schemaVersion = root["schemaVersion"];
  if (schemaVersion !== LEGAL_SNAPSHOT_SCHEMA_VERSION) {
    throw new LegalSnapshotError(
      `离线法条快照 schemaVersion=${String(schemaVersion)}，本程序期望 ${LEGAL_SNAPSHOT_SCHEMA_VERSION}（请重建快照）`,
    );
  }
  const snapshotAt = root["snapshotAt"];
  if (typeof snapshotAt !== "string" || snapshotAt === "") {
    throw new LegalSnapshotError(`离线法条快照清单缺少 snapshotAt：${path}`);
  }
  const skipped = readSkipped(root["skipped"]);
  return {
    schemaVersion: LEGAL_SNAPSHOT_SCHEMA_VERSION,
    snapshotAt,
    source: typeof root["source"] === "string" ? root["source"] : "",
    license: typeof root["license"] === "string" ? root["license"] : "",
    format: typeof root["format"] === "string" ? root["format"] : "",
    file: typeof root["file"] === "string" ? root["file"] : LEGAL_SNAPSHOT_DATA_FILE,
    lawCount: typeof root["lawCount"] === "number" ? root["lawCount"] : 0,
    articleCount: typeof root["articleCount"] === "number" ? root["articleCount"] : 0,
    byteSize: typeof root["byteSize"] === "number" ? root["byteSize"] : 0,
    sha256: typeof root["sha256"] === "string" ? root["sha256"] : "",
    ...(skipped ? { skipped } : {}),
  };
}

/** 读取 skipped 统计（形状非法时整体丢弃，不阻塞快照加载）。 */
function readSkipped(value: unknown): LegalSnapshotManifest["skipped"] | undefined {
  if (!isRecord(value)) return undefined;
  const count = typeof value["count"] === "number" ? value["count"] : undefined;
  const reasons = isRecord(value["reasons"])
    ? Object.fromEntries(
        Object.entries(value["reasons"]).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : {};
  const samples = Array.isArray(value["samples"])
    ? value["samples"].filter(
        (item): item is { file: string; reason: string } =>
          isRecord(item) && typeof item["file"] === "string" && typeof item["reason"] === "string",
      )
    : undefined;
  if (count === undefined && samples === undefined) return undefined;
  return { count: count ?? samples?.length ?? 0, reasons, ...(samples ? { samples } : {}) };
}

function parseLawLine(line: string, index: number): LegalSnapshotLaw {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch (error) {
    throw new LegalSnapshotError(`离线法条快照第 ${index + 1} 行不是合法 JSON（${(error as Error).message}）`);
  }
  if (!isRecord(root)) throw new LegalSnapshotError(`离线法条快照第 ${index + 1} 行必须是对象`);
  const name = root["n"];
  const document = root["d"];
  if (typeof name !== "string" || typeof document !== "string") {
    throw new LegalSnapshotError(`离线法条快照第 ${index + 1} 行缺少 n/d`);
  }
  const rawArticles = root["a"];
  if (!Array.isArray(rawArticles)) {
    throw new LegalSnapshotError(`离线法条快照第 ${index + 1} 行缺少 a 数组`);
  }
  const articles: Array<[number, string]> = [];
  for (const item of rawArticles) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const number = item[0];
    const text = item[1];
    if (typeof number !== "number" || typeof text !== "string") continue;
    articles.push([number, text]);
  }
  return {
    n: name,
    d: document,
    a: articles,
    ...(typeof root["s"] === "string" ? { s: root["s"] } : {}),
    ...(typeof root["v"] === "string" ? { v: root["v"] } : {}),
  };
}

/** 条号 → "第 N 条"（快照条号均为整数，不存在子条编号）。 */
function articleLabel(number: number): string {
  return `第${number}条`;
}

/** 截取命中上下文（模型侧可读的来源片段）。 */
function snippetOf(text: string, keywords: readonly string[]): string | undefined {
  let best = -1;
  let bestKeyword = "";
  for (const keyword of keywords) {
    const at = text.indexOf(keyword);
    if (at >= 0 && (best === -1 || at < best)) {
      best = at;
      bestKeyword = keyword;
    }
  }
  if (best === -1) return undefined;
  const start = Math.max(0, best - 20);
  const end = Math.min(text.length, best + bestKeyword.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export class LegalSnapshotEngine implements LegalSearchSource {
  /** 快照无 FTS 索引（线性匹配），恒 false。 */
  readonly ftsAvailable = false;
  /** 快照无施行日/失效字段：时点检索不支持，如实标注。 */
  readonly timeFilter: LegalTimeFilter = "unsupported";
  readonly manifest: LegalSnapshotManifest;
  readonly snapshotDir: string;

  private laws: LegalSnapshotLaw[] | null = null;

  constructor(snapshotDir: string) {
    this.snapshotDir = snapshotDir;
    this.manifest = readManifest(snapshotDir);
    const dataPath = join(snapshotDir, this.manifest.file);
    if (!existsSync(dataPath)) {
      throw new LegalSnapshotError(`离线法条快照数据文件缺失：${dataPath}`);
    }
  }

  /** 首次查询时才解压 + 解析（在线库可用时不触发）。 */
  private getLaws(): LegalSnapshotLaw[] {
    if (this.laws !== null) return this.laws;
    const dataPath = join(this.snapshotDir, this.manifest.file);
    let text: string;
    try {
      text = gunzipSync(readFileSync(dataPath)).toString("utf8");
    } catch (error) {
      throw new LegalSnapshotError(`离线法条快照解压失败：${dataPath}（${(error as Error).message}）`);
    }
    this.laws = text
      .split("\n")
      .filter(line => line.trim() !== "")
      .map((line, index) => parseLawLine(line, index));
    return this.laws;
  }

  private toResult(law: LegalSnapshotLaw, article: number, text: string, keywords: readonly string[]): LawSearchResult {
    const snippet = snippetOf(text, keywords);
    return {
      id: `${law.d}#${articleLabel(article)}`,
      level: "其他",
      name: law.d,
      categoryId: 0,
      content: text,
      article: articleLabel(article),
      score: 0,
      ...(snippet === undefined ? {} : { snippet }),
    };
  }

  search(
    keyword: string,
    options: { limit?: number; level?: string; category?: string; asOf?: string } = {},
  ): LawSearchResult[] {
    const limit = options.limit ?? 10;
    const keywords = extractLawKeywords(keyword);
    const terms = keywords.length > 0 ? keywords : [keyword];
    const results: LawSearchResult[] = [];
    for (const law of this.getLaws()) {
      // 法名/文档名命中优先（"专利法" 这类查询不必逐条扫正文）。
      const nameHit = terms.some(term => law.n.includes(term) || law.d.includes(term));
      if (nameHit) {
        const first = law.a[0];
        if (first !== undefined) results.push(this.toResult(law, first[0], first[1], terms));
        if (results.length >= limit) break;
        continue;
      }
      for (const [number, text] of law.a) {
        if (terms.some(term => text.includes(term))) {
          results.push(this.toResult(law, number, text, terms));
          if (results.length >= Math.min(limit * 3, MAX_MATCHES)) break;
        }
      }
      if (results.length >= Math.min(limit * 3, MAX_MATCHES)) break;
    }
    return results;
  }

  /** 时点检索：快照无日期字段，原样返回并标注 unsupported（不伪造近似口径）。 */
  searchAt(
    keyword: string,
    options: { limit?: number; level?: string; category?: string; asOf: string },
  ): TimedLegalSearchResult {
    const results = this.search(keyword, options);
    return { results, meta: { timeFilter: "unsupported", unknownDateCount: results.length } };
  }

  findByName(name: string, limit = 10): LawRecord[] {
    const records: LawRecord[] = [];
    const keywords = extractLawKeywords(name);
    const terms = keywords.length > 0 ? keywords : [name];
    for (const law of this.getLaws()) {
      if (!terms.some(term => law.n.includes(term) || law.d.includes(term))) continue;
      let content = "";
      for (const [number, text] of law.a) {
        content += `${articleLabel(number)} ${text}\n`;
        if (content.length >= MAX_JOINED_CHARS) break;
      }
      records.push({
        id: `${law.d}#${articleLabel(law.a[0]?.[0] ?? 1)}`,
        level: "其他",
        name: law.d,
        categoryId: 0,
        content,
      });
      if (records.length >= limit) break;
    }
    return records;
  }

  getById(id: string): LawRecord | undefined {
    const match = /^(.*)#第(\d+)条$/u.exec(id);
    if (match === null) return undefined;
    const document = match[1]!;
    const number = Number(match[2]);
    const law = this.getLaws().find(candidate => candidate.d === document || candidate.n === document);
    const article = law?.a.find(([candidate]) => candidate === number);
    if (law === undefined || article === undefined) return undefined;
    return this.toResult(law, article[0], article[1], []);
  }

  getByIds(ids: string[]): LawRecord[] {
    const records: LawRecord[] = [];
    for (const id of new Set(ids)) {
      const record = this.getById(id);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /** 快照无分类概念。 */
  getCategories(): LawCategory[] {
    return [];
  }

  count(): number {
    return this.manifest.lawCount;
  }

  close(): void {
    this.laws = null;
  }
}
