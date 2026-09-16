/**
 * src/patent/chemistry — 化学式识别索引（持久化）。
 *
 * 识别结果（ChemicalStructureResult）以 JSON 文件形式落盘（默认
 * `.sati/chemistry-index.json`，工作区根目录下），供后续检索/校验管线消费。写入走原子写
 * （同目录临时文件 + rename），同一文件路径的并发 upsert 在进程内串行化，避免"读-改-写"
 * 竞态丢条目。
 *
 * 读容错/版本守卫/shape 守卫/队列串行化/损坏备份等共性已收敛到
 * `src/patent/shared/index-store.ts`；本模块只声明化学索引的域差异（来源键为 `sourceKey`、
 * 按来源键字典序排序、analysis 的校验字段）。
 *
 * 本模块不依赖 tool 层：文件路径由调用方（工具层）经路径沙箱解析后传入。
 */

import { createIndexStore, type IndexFile, type LoadIndexResult } from "../shared/index-store.js";
import type { ChemicalStructureResult } from "./types.js";

/** 索引文件版本（结构不兼容时升版，旧文件按空索引处理）。 */
export const CHEMISTRY_INDEX_VERSION = 1 as const;

/** 索引文件默认位置（工作区根相对路径）。 */
export const DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH = ".sati/chemistry-index.json";

/**
 * 索引条目：一次化学式识别结果。
 * sourceKey 为来源标识：图片模式为工作区相对图片路径，文本模式为 `text:<hash>`。
 */
export type ChemistryIndexEntry = {
  /** 来源标识（图片相对路径或 text 哈希）。 */
  sourceKey: string;
  /** 识别时间（ISO 8601）。 */
  analyzedAt: string;
  /** 识别结果。 */
  analysis: ChemicalStructureResult;
};

/** 索引文件结构。 */
export type ChemistryIndexFile = IndexFile<typeof CHEMISTRY_INDEX_VERSION, ChemistryIndexEntry>;

export type LoadChemistryIndexResult = LoadIndexResult<ChemistryIndexEntry>;

function isChemistryIndexEntry(value: unknown): value is ChemistryIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ChemistryIndexEntry>;
  const analysis = entry.analysis as Partial<ChemicalStructureResult> | undefined;
  return (
    typeof entry.sourceKey === "string" &&
    typeof entry.analyzedAt === "string" &&
    typeof analysis === "object" &&
    analysis !== null &&
    typeof analysis.kind === "string" &&
    typeof analysis.chosenIndex === "number" &&
    // 数组字段必须为数组：否则下游消费方（map/filter 等）会以裸 TypeError 崩溃
    Array.isArray(analysis.candidates) &&
    Array.isArray(analysis.names) &&
    Array.isArray(analysis.warnings)
  );
}

const store = createIndexStore({
  label: "化学索引",
  version: CHEMISTRY_INDEX_VERSION,
  keyOf: entry => entry.sourceKey,
  compare: (a, b) => a.sourceKey.localeCompare(b.sourceKey),
  isValidEntry: isChemistryIndexEntry,
});

/** 读取索引：文件缺失 → 空索引；损坏/版本不兼容 → 空索引 + warning（不抛出）。 */
export async function loadChemistryIndex(filePath: string): Promise<LoadChemistryIndexResult> {
  return store.load(filePath);
}

/** 整体写回索引（调用方负责保证目录可写；不串行化，批量重建场景用）。 */
export async function saveChemistryIndex(filePath: string, entries: ChemistryIndexEntry[]): Promise<void> {
  return store.save(filePath, entries);
}

/** 按 sourceKey 合并进索引：同源覆盖、新源追加，排序后写回。 */
export async function upsertChemistryIndex(filePath: string, entry: ChemistryIndexEntry): Promise<void> {
  return store.upsert(filePath, entry);
}
