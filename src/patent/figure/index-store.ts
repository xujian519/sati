/**
 * src/patent/figure/index-store — 附图分析索引（持久化）。
 *
 * 附图分析结果（FigureAnalysisResult）以 JSON 文件形式落盘（默认
 * `.sati/figures-index.json`，工作区根目录下），供 search_patent_figure
 * 检索。写入走原子写（同目录临时文件 + rename），同一文件路径的并发
 * upsert 在进程内串行化，避免"读-改-写"竞态丢条目。
 *
 * 读容错/版本守卫/shape 守卫/队列串行化/损坏备份等共性已收敛到
 * `src/patent/shared/index-store.ts`；本模块只声明附图索引的域差异（来源键为 `imagePath`、
 * 先按附图编号再按路径排序、analysis 的校验字段）。
 *
 * 本模块不依赖 tool 层（与 analyze.ts 同约）：文件路径由调用方（工具层）
 * 经路径沙箱解析后传入。
 */

import { createIndexStore, type IndexFile, type LoadIndexResult } from "../shared/index-store.js";
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
export type FigureIndexFile = IndexFile<typeof FIGURE_INDEX_VERSION, FigureIndexEntry>;

export type LoadFigureIndexResult = LoadIndexResult<FigureIndexEntry>;

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

const store = createIndexStore({
  label: "附图索引",
  version: FIGURE_INDEX_VERSION,
  keyOf: entry => entry.imagePath,
  compare: (a, b) => a.analysis.figureNumber - b.analysis.figureNumber || a.imagePath.localeCompare(b.imagePath),
  isValidEntry: isFigureIndexEntry,
});

/** 读取索引：文件缺失 → 空索引；损坏/版本不兼容 → 空索引 + warning（不抛出）。 */
export async function loadFigureIndex(filePath: string): Promise<LoadFigureIndexResult> {
  return store.load(filePath);
}

/** 整体写回索引（调用方负责保证目录可写；不串行化，批量重建场景用）。 */
export async function saveFigureIndex(filePath: string, entries: FigureIndexEntry[]): Promise<void> {
  return store.save(filePath, entries);
}

/** 按 imagePath 合并进索引：同图覆盖、新图追加，按附图编号排序后写回。 */
export async function upsertFigureIndex(filePath: string, entry: FigureIndexEntry): Promise<void> {
  return store.upsert(filePath, entry);
}
