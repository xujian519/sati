/**
 * 模型窗口覆盖层的持久化（issue #449）。
 *
 * 落盘位置 `~/.sati/model-windows.json`（`SATI_HOME` 同口径，走 `resolvePilotHome`）。
 * 为什么单开一个文件而不写回 `sati.yaml`：`src/` 内没有 sati.yaml 写通道
 * （`PilotConfigStore` 只读，写入在 `ui/server` 与 `cli/commands/configSet` 两侧），
 * 且探测结果属于**运行时事实**而非用户配置，混写会让"用户改了什么"不可辨认。
 *
 * 三处硬约束：
 * - **同步读**：`parseModelConfig` 是同步解析，覆盖层必须能同步取到（`readFileSync`）。
 * - **fail-open**：文件缺失/损坏/版本未知一律按空处理，绝不因缓存问题阻断启动。
 * - **冲突取小**：同一 provider/model 的 `observed` 与 `probe` 冲突时采纳较小值，
 *   并保留**被采纳值**的来源标注（不把 probe 的值冒充 observed）。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../../patent/persist-utils.js";
import { resolvePilotHome } from "../../shared/paths/pilotPaths.js";
import type { ModelWindowEntry, ModelWindowFile, ModelWindowSource } from "./types.js";
import { isPlausibleWindowTokens, modelWindowKey, MODEL_WINDOW_STORE_VERSION } from "./types.js";

export const MODEL_WINDOW_STORE_FILENAME = "model-windows.json";

export { modelWindowKey };

/** 默认落盘路径：`<pilotHome>/model-windows.json`。 */
export function defaultModelWindowStorePath(env: Record<string, string | undefined> = process.env): string {
  return join(resolvePilotHome(env), MODEL_WINDOW_STORE_FILENAME);
}

function emptyFile(): ModelWindowFile {
  return { version: MODEL_WINDOW_STORE_VERSION, entries: {} };
}

function sanitizeEntry(raw: unknown): ModelWindowEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const source = record.source;
  if (source !== "probe" && source !== "observed") return undefined;
  const maxContextTokens = isPlausibleWindowTokens(record.maxContextTokens)
    ? Math.floor(record.maxContextTokens)
    : undefined;
  const maxOutputTokens = isPlausibleWindowTokens(record.maxOutputTokens)
    ? Math.floor(record.maxOutputTokens)
    : undefined;
  if (maxContextTokens === undefined && maxOutputTokens === undefined) return undefined;
  return {
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    source,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    ...(typeof record.via === "string" && record.via.length > 0 ? { via: record.via } : {}),
  };
}

/** 解析覆盖文件正文（容错：任何异常/未知版本 → 空表）。 */
export function parseModelWindowFile(raw: string): ModelWindowFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyFile();
  const record = parsed as Record<string, unknown>;
  if (record.version !== MODEL_WINDOW_STORE_VERSION) return emptyFile();
  const entriesRaw = record.entries;
  if (typeof entriesRaw !== "object" || entriesRaw === null || Array.isArray(entriesRaw)) return emptyFile();
  const entries: Record<string, ModelWindowEntry> = {};
  for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
    const entry = sanitizeEntry(value);
    if (entry) entries[key] = entry;
  }
  return { version: MODEL_WINDOW_STORE_VERSION, entries };
}

type PickedValue = { value?: number; source?: ModelWindowSource; via?: string };

/**
 * 维度级采纳：两边都有值时取较小者，并让**被采纳值的来源**成为该维度的来源。
 * 这样 `source: observed` 只在 observed 的值真的被采纳时出现，不冒充。
 */
function pickSmaller(
  key: "maxContextTokens" | "maxOutputTokens",
  existing: ModelWindowEntry | undefined,
  incoming: ModelWindowEntry,
): PickedValue {
  const a = existing?.[key];
  const b = incoming[key];
  if (a === undefined) return { value: b, source: incoming.source, via: incoming.via };
  if (b === undefined) return { value: a, source: existing?.source, via: existing?.via };
  return a <= b
    ? { value: a, source: existing?.source, via: existing?.via }
    : { value: b, source: incoming.source, via: incoming.via };
}

/**
 * 合并新旧两条覆盖记录：逐维度取小，来源跟随被采纳值；`updatedAt` 取写入时刻，
 * `via` 跟随上下文窗口那一维（它是压缩线实际使用的维度）。
 */
export function mergeModelWindowEntry(
  existing: ModelWindowEntry | undefined,
  incoming: ModelWindowEntry,
): ModelWindowEntry {
  const context = pickSmaller("maxContextTokens", existing, incoming);
  const output = pickSmaller("maxOutputTokens", existing, incoming);
  const source = context.source ?? output.source ?? incoming.source;
  const via = context.via ?? output.via;
  return {
    ...(context.value !== undefined ? { maxContextTokens: context.value } : {}),
    ...(output.value !== undefined ? { maxOutputTokens: output.value } : {}),
    source,
    updatedAt: incoming.updatedAt,
    ...(via !== undefined ? { via } : {}),
  };
}

/**
 * 覆盖层存储。读路径同步（解析期要用），写路径原子（探测/观测回写）。
 * 读写都吞掉 IO 异常：缓存坏了不该让 agent 起不来。
 */
export class ModelWindowStore {
  constructor(private readonly filePath: string = defaultModelWindowStorePath()) {}

  /** 同步读取整表；文件缺失/损坏 → 空表。 */
  read(): ModelWindowFile {
    try {
      return parseModelWindowFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return emptyFile();
    }
  }

  /** 单条查询（解析期热路径）。 */
  lookup(provider: string, model: string): ModelWindowEntry | undefined {
    return this.read().entries[modelWindowKey(provider, model)];
  }

  /** 写入一条事实（与既有条目按冲突取小合并），返回合并后的条目。 */
  async record(provider: string, model: string, entry: ModelWindowEntry): Promise<ModelWindowEntry> {
    const file = this.read();
    const key = modelWindowKey(provider, model);
    const merged = mergeModelWindowEntry(file.entries[key], entry);
    const next: ModelWindowFile = {
      version: MODEL_WINDOW_STORE_VERSION,
      entries: { ...file.entries, [key]: merged },
    };
    await this.writeFile(next);
    return merged;
  }

  /** 清除一条（设置页"清除探测值"用）。返回是否确有删除。 */
  async forget(provider: string, model: string): Promise<boolean> {
    const file = this.read();
    const key = modelWindowKey(provider, model);
    if (file.entries[key] === undefined) return false;
    const entries = { ...file.entries };
    delete entries[key];
    await this.writeFile({ version: MODEL_WINDOW_STORE_VERSION, entries });
    return true;
  }

  private async writeFile(file: ModelWindowFile): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    await atomicWriteJson(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}
