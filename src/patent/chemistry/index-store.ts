/**
 * src/patent/chemistry — 化学式识别索引（持久化）。
 *
 * 识别结果（ChemicalStructureResult）以 JSON 文件形式落盘（默认
 * `.sati/chemistry-index.json`，工作区根目录下），供后续检索/校验管线消费。
 * 写入走原子写（同目录临时文件 + rename），同一文件路径的并发 upsert 在进程内
 * 串行化，避免"读-改-写"竞态丢条目——与 figure/index-store.ts 同构。
 *
 * 本模块不依赖 tool 层：文件路径由调用方（工具层）经路径沙箱解析后传入。
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteJson } from "../persist-utils.js";
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
export type ChemistryIndexFile = {
  version: typeof CHEMISTRY_INDEX_VERSION;
  updatedAt: string;
  entries: ChemistryIndexEntry[];
};

export type LoadChemistryIndexResult = {
  entries: ChemistryIndexEntry[];
  /** 非致命异常提示（文件损坏/版本不兼容/无效条目被忽略），无则省略。 */
  warning?: string;
};

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

/** 读取索引：文件缺失 → 空索引；损坏/版本不兼容 → 空索引 + warning（不抛出）。 */
export async function loadChemistryIndex(filePath: string): Promise<LoadChemistryIndexResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChemistryIndexFile>;
    if (parsed.version !== CHEMISTRY_INDEX_VERSION || !Array.isArray(parsed.entries)) {
      return { entries: [], warning: "化学索引版本不兼容或结构异常，已按空索引处理" };
    }
    const entries = parsed.entries.filter(isChemistryIndexEntry);
    const dropped = parsed.entries.length - entries.length;
    return dropped > 0 ? { entries, warning: `化学索引中存在 ${dropped} 条无效条目，已忽略` } : { entries };
  } catch {
    return { entries: [], warning: "化学索引文件损坏，已按空索引处理" };
  }
}

/** 整体写回索引（调用方负责保证目录可写；不串行化，批量重建场景用）。 */
export async function saveChemistryIndex(filePath: string, entries: ChemistryIndexEntry[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteJson(
    filePath,
    JSON.stringify(
      { version: CHEMISTRY_INDEX_VERSION, updatedAt: new Date().toISOString(), entries } satisfies ChemistryIndexFile,
      null,
      2,
    ),
  );
}

/** 按 sourceKey 合并进索引：同源覆盖、新源追加，排序后写回。 */
export async function upsertChemistryIndex(filePath: string, entry: ChemistryIndexEntry): Promise<void> {
  const previous = upsertQueues.get(filePath) ?? Promise.resolve();
  const run = previous.then(async () => {
    const { entries, warning } = await loadChemistryIndex(filePath);
    // 命中损坏/版本不兼容/含无效条目的旧索引时，先保留原始文件备份，
    // 避免用仅含新条目的内容静默覆盖掉原有的有效条目。
    if (warning) await backupCorruptIndex(filePath);
    const next = entries.filter(existing => existing.sourceKey !== entry.sourceKey);
    next.push(entry);
    next.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    await saveChemistryIndex(filePath, next);
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
