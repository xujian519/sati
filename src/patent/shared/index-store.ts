/**
 * src/patent/shared/index-store — 「一案一份 JSON 索引」的通用持久化工厂。
 *
 * 化学式识别索引（`chemistry/index-store.ts`）与附图分析索引（`figure/index-store.ts`）
 * 此前是两份**同构副本**（并集 179 行中 85 行逐字节相同），且已靠人工维持同步、事实上
 * 开始漂移。本模块把共性——读容错、版本守卫、逐条 shape 守卫、队列串行化 upsert、
 * 损坏备份——收敛为一处，两侧只注入**真实的域差异**：
 *
 * | 差异点 | 化学索引 | 附图索引 |
 * |---|---|---|
 * | `label`（warning 文案前缀） | 化学索引 | 附图索引 |
 * | `keyOf`（合并去重依据） | `sourceKey` | `imagePath` |
 * | `compare`（写回排序） | 来源键字典序 | 先附图编号、再路径 |
 * | `isValidEntry`（逐条 shape 守卫） | 校验 `kind/chosenIndex/candidates/names/warnings` | 校验 `figureNumber/figureType/components/connections/warnings` |
 *
 * 本模块不依赖 tool 层：文件路径由调用方（工具层）经路径沙箱解析后传入。
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteJson } from "../persist-utils.js";

/** 索引条目最小形状：来源键 + 识别时间 + 识别结果（来源键字段名由 `keyOf` 声明）。 */
export type IndexEntryBase = {
  /** 识别时间（ISO 8601）。 */
  analyzedAt: string;
};

/** 索引文件结构（版本字段为字面量类型，便于与各自的 `*IndexFile` 保持同一份真相）。 */
export type IndexFile<TVersion extends number, TEntry> = {
  version: TVersion;
  updatedAt: string;
  entries: TEntry[];
};

/** 读取结果：`warning` 仅在非致命异常（损坏/版本不兼容/无效条目被忽略）时出现。 */
export type LoadIndexResult<TEntry> = {
  entries: TEntry[];
  /** 非致命异常提示（文件损坏/版本不兼容/无效条目被忽略），无则省略。 */
  warning?: string;
};

/** 各索引的域差异注入点；除这五项外两侧逻辑必须完全一致。 */
export type IndexStoreSpec<TVersion extends number, TEntry extends IndexEntryBase> = {
  /** 提示文案前缀（如 `化学索引` / `附图索引`），与共享句式拼成完整 warning。 */
  label: string;
  /** 索引文件版本（结构不兼容时升版，旧文件按空索引处理）。 */
  version: TVersion;
  /** 条目的来源键（`upsert` 的合并去重依据：同键覆盖、新键追加）。 */
  keyOf: (entry: TEntry) => string;
  /** 写回前的排序比较器。 */
  compare: (a: TEntry, b: TEntry) => number;
  /** 逐条 shape 守卫：磁盘半写/手改产生的畸形条目在此被过滤，不进入下游消费路径。 */
  isValidEntry: (value: unknown) => value is TEntry;
};

export type IndexStore<TEntry extends IndexEntryBase> = {
  /** 读取索引：文件缺失 → 空索引；损坏/版本不兼容 → 空索引 + warning（不抛出）。 */
  load(filePath: string): Promise<LoadIndexResult<TEntry>>;
  /** 整体写回索引（调用方负责保证目录可写；不串行化，批量重建场景用）。 */
  save(filePath: string, entries: TEntry[]): Promise<void>;
  /** 按来源键合并进索引：同源覆盖、新源追加，排序后写回。 */
  upsert(filePath: string, entry: TEntry): Promise<void>;
  /**
   * 当前仍有排队写入的文件路径数（自检/测试用）。
   *
   * 暴露它是为了让「队尾清退」这条实现选择**可观测**：清退若不生效，长驻进程跨大量
   * case 后该 Map 会无界增长，而这一点没有任何其它外部可观测差异（条目数、产物内容
   * 都一样）。判据侧因此须能直接读到队尾长度。
   */
  pendingWrites(): number;
};

/**
 * 构造一个索引存储实例。
 *
 * 每个实例持有**自己的**写队列（与收敛前「每模块一份 `upsertQueues`」等价）：
 * 不同索引即使共用同一路径也互不阻塞。
 */
export function createIndexStore<TVersion extends number, TEntry extends IndexEntryBase>(
  spec: IndexStoreSpec<TVersion, TEntry>,
): IndexStore<TEntry> {
  const { label, version, keyOf, compare, isValidEntry } = spec;

  const load = async (filePath: string): Promise<LoadIndexResult<TEntry>> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IndexFile<TVersion, TEntry>>;
      if (parsed.version !== version || !Array.isArray(parsed.entries)) {
        return { entries: [], warning: `${label}版本不兼容或结构异常，已按空索引处理` };
      }
      const entries = parsed.entries.filter(isValidEntry);
      const dropped = parsed.entries.length - entries.length;
      return dropped > 0 ? { entries, warning: `${label}中存在 ${dropped} 条无效条目，已忽略` } : { entries };
    } catch {
      return { entries: [], warning: `${label}文件损坏，已按空索引处理` };
    }
  };

  const save = async (filePath: string, entries: TEntry[]): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    const file: IndexFile<TVersion, TEntry> = { version, updatedAt: new Date().toISOString(), entries };
    await atomicWriteJson(filePath, JSON.stringify(file, null, 2));
  };

  /** 进程内写队列：同一文件路径的 upsert 串行执行（防读-改-写竞态）。 */
  const upsertQueues = new Map<string, Promise<unknown>>();

  const upsert = async (filePath: string, entry: TEntry): Promise<void> => {
    const previous = upsertQueues.get(filePath) ?? Promise.resolve();
    const run = previous.then(async () => {
      const { entries, warning } = await load(filePath);
      // 命中损坏/版本不兼容/含无效条目的旧索引时，先保留原始文件备份，
      // 避免用仅含新条目的内容静默覆盖掉原有的有效条目。
      if (warning) await backupCorruptIndex(filePath);
      const next = entries.filter(existing => keyOf(existing) !== keyOf(entry));
      next.push(entry);
      next.sort(compare);
      await save(filePath, next);
    });
    // 队列吞掉失败，避免一条失败阻塞后续写入；调用方 await run 感知自身失败。
    const settled = run.catch(() => {});
    upsertQueues.set(filePath, settled);
    try {
      await run;
    } finally {
      // 队尾清退：仅当自己仍是队尾（无后继排队）时移除该键，否则会破坏后续写入的串行化
      // （后继的 previous 指向的链已被删除，它会与本次并发执行）。不做清退则 Map 以文件
      // 路径为键长期驻留，长驻进程跨大量 case 后无界增长（TD-PATENT-N24）。
      if (upsertQueues.get(filePath) === settled) upsertQueues.delete(filePath);
    }
  };

  return { load, save, upsert, pendingWrites: () => upsertQueues.size };
}

/** 原始索引文件备份（`.corrupt-<时间戳>` 后缀）；备份失败不阻断写入。 */
async function backupCorruptIndex(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.corrupt-${Date.now()}`);
  } catch {
    // 备份失败静默降级，索引写入照常进行。
  }
}
