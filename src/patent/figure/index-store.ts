/**
 * src/patent/figure/index-store — 附图分析索引（持久化）。
 *
 * 附图分析结果（FigureAnalysisResult）以 JSON 文件形式落盘（默认
 * `.sati/figures-index.json`，工作区根目录下），供 search_patent_figure
 * 检索。写入走原子写（同目录临时文件 + rename），同一文件路径的并发
 * upsert 在进程内串行化，避免"读-改-写"竞态丢条目。
 *
 * 本模块不依赖 tool 层（与 analyze.ts 同约）：文件路径由调用方（工具层）
 * 经路径沙箱解析后传入。
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteJson } from "../persist-utils.js";
import type { FigureAnalysisResult } from "./types.js";

/** 索引文件版本（结构不兼容时升版，旧文件按空索引处理）。 */
export const FIGURE_INDEX_VERSION = 1 as const;

/** 索引文件默认位置（工作区根相对路径）。 */
export const DEFAULT_FIGURE_INDEX_RELATIVE_PATH = ".sati/figures-index.json";

/** 索引条目：一张已分析附图。 */
export type FigureIndexEntry = {
  /** 附图图片路径（工作区相对路径，与 FigureAnalysisResult.imagePath 一致）。 */
  imagePath: string;
  /** 分析时间（ISO 8601）。 */
  analyzedAt: string;
  /** 附图分析结果。 */
  analysis: FigureAnalysisResult;
};

/** 索引文件结构。 */
export type FigureIndexFile = {
  version: typeof FIGURE_INDEX_VERSION;
  updatedAt: string;
  entries: FigureIndexEntry[];
};

export type LoadFigureIndexResult = {
  entries: FigureIndexEntry[];
  /** 非致命异常提示（文件损坏/版本不兼容/无效条目被忽略），无则省略。 */
  warning?: string;
};

function isFigureIndexEntry(value: unknown): value is FigureIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<FigureIndexEntry>;
  const analysis = entry.analysis as Partial<FigureAnalysisResult> | undefined;
  return (
    typeof entry.imagePath === "string" &&
    typeof entry.analyzedAt === "string" &&
    typeof analysis === "object" &&
    analysis !== null &&
    typeof analysis.figureNumber === "number" &&
    typeof analysis.figureType === "string" &&
    // 数组字段必须为数组：否则下游检索（components.map 等）会以裸 TypeError 崩溃
    Array.isArray(analysis.components) &&
    Array.isArray(analysis.connections) &&
    Array.isArray(analysis.warnings)
  );
}

/** 读取索引：文件缺失 → 空索引；损坏/版本不兼容 → 空索引 + warning（不抛出）。 */
export async function loadFigureIndex(filePath: string): Promise<LoadFigureIndexResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FigureIndexFile>;
    if (parsed.version !== FIGURE_INDEX_VERSION || !Array.isArray(parsed.entries)) {
      return { entries: [], warning: "附图索引版本不兼容或结构异常，已按空索引处理" };
    }
    const entries = parsed.entries.filter(isFigureIndexEntry);
    const dropped = parsed.entries.length - entries.length;
    return dropped > 0 ? { entries, warning: `附图索引中存在 ${dropped} 条无效条目，已忽略` } : { entries };
  } catch {
    return { entries: [], warning: "附图索引文件损坏，已按空索引处理" };
  }
}

/** 整体写回索引（调用方负责保证目录可写；不串行化，批量重建场景用）。 */
export async function saveFigureIndex(filePath: string, entries: FigureIndexEntry[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteJson(
    filePath,
    JSON.stringify(
      { version: FIGURE_INDEX_VERSION, updatedAt: new Date().toISOString(), entries } satisfies FigureIndexFile,
      null,
      2,
    ),
  );
}

/** 按 imagePath 合并进索引：同图覆盖、新图追加，按附图编号排序后写回。 */
export async function upsertFigureIndex(filePath: string, entry: FigureIndexEntry): Promise<void> {
  const previous = upsertQueues.get(filePath) ?? Promise.resolve();
  const run = previous.then(async () => {
    const { entries, warning } = await loadFigureIndex(filePath);
    // 命中损坏/版本不兼容/含无效条目的旧索引时，先保留原始文件备份，
    // 避免用仅含新条目的内容静默覆盖掉原有的有效条目。
    if (warning) await backupCorruptIndex(filePath);
    const next = entries.filter(existing => existing.imagePath !== entry.imagePath);
    next.push(entry);
    next.sort((a, b) => a.analysis.figureNumber - b.analysis.figureNumber || a.imagePath.localeCompare(b.imagePath));
    await saveFigureIndex(filePath, next);
  });
  // 队列吞掉失败，避免一条失败阻塞后续写入；调用方 await run 感知自身失败。
  upsertQueues.set(
    filePath,
    run.catch(() => {}),
  );
  await run;
}

/** 原始索引文件备份（`.corrupt-<时间戳>` 后缀）；备份失败不阻断写入。 */
async function backupCorruptIndex(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // 备份失败静默降级，索引写入照常进行。
  }
}

/** 进程内写队列：同一文件路径的 upsert 串行执行（防读-改-写竞态）。 */
const upsertQueues = new Map<string, Promise<unknown>>();
