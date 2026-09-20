/**
 * 从 provider `/models` 响应里抽取窗口事实（issue #449 构件①的纯逻辑层）。
 *
 * 设计约束（前车之鉴：宽松键匹配会把 `max_tokens` 这类输出配额当上下文窗口，
 * 一旦写进覆盖层就会被持久化，导致窗口被永久低估）：
 * - 只认**明确键名**，不做模糊匹配；
 * - 只读列表条目自身与少数**具名嵌套容器**的顶层键（`details`/`meta`/`model_info`/
 *   `top_provider`），不递归遍历任意深度；
 * - 每个数值都要过 `isPlausibleWindowTokens` 区间校验；
 * - 拿不到就**不产出条目**（宁缺勿错）。
 */
import { isPlausibleWindowTokens, MODEL_WINDOW_MAX_TOKENS, MODEL_WINDOW_MIN_TOKENS } from "./types.js";

/** 单条探测结果。 */
export type ModelWindowProbeHit = {
  modelId: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** 命中上下文窗口的键名（诊断用，供设置页显示"来自 /models 的 xxx 字段"）。 */
  contextVia?: string;
  /** 命中输出上限的键名。 */
  outputVia?: string;
};

/** 上下文窗口候选键（按可信度排序：越靠前越专用）。 */
const CONTEXT_KEYS = [
  "context_length",
  "context_window",
  "max_context_tokens",
  "max_context_length",
  "max_input_tokens",
  "inputTokenLimit",
  "n_ctx_train",
  "max_model_len",
] as const;

/**
 * 输出上限候选键。`max_tokens` 排在末位：OpenAI 兼容站里它通常表示输出配额
 * （Anthropic 的 `/v1/models` 同义），但也偶有站点用它表示请求上限 —— 区间校验与
 * 排位顺序让专用键先命中，末位才轮到它。
 */
const OUTPUT_KEYS = [
  "max_output_tokens",
  "max_completion_tokens",
  "outputTokenLimit",
  "max_output_length",
  "max_tokens",
] as const;

/** 允许下探的具名嵌套容器（不递归，只看这些容器的直接子键）。 */
const NESTED_CONTAINERS = ["details", "meta", "model_info", "top_provider"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 数字或纯数字字符串（部分站点把窗口序列化成字符串）。 */
function readPlausibleNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): { value: number; via: string } | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (isPlausibleWindowTokens(raw)) {
      return { value: Math.floor(raw), via: key };
    }
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
      const parsed = Number(raw.trim());
      if (isPlausibleWindowTokens(parsed)) return { value: Math.floor(parsed), via: key };
    }
  }
  return undefined;
}

/** 条目里的模型标识：`id` / `name` / `model`，Google 的 `models/xxx` 前缀剥掉。 */
function readModelId(entry: Record<string, unknown>): string | undefined {
  const raw = readString(entry.id) ?? readString(entry.name) ?? readString(entry.model);
  if (!raw) return undefined;
  return raw.startsWith("models/") ? raw.slice("models/".length) : raw;
}

/** 列表容器：`data[]` / `models[]` / 顶层数组。 */
function readEntries(body: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(body)) {
    return body.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  }
  const record = asRecord(body);
  if (!record) return undefined;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!list) return undefined;
  return list.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

/** 一个条目 → 一条窗口事实（拿不到任何窗口时不产出）。 */
function probeEntry(entry: Record<string, unknown>): ModelWindowProbeHit | undefined {
  const modelId = readModelId(entry);
  if (!modelId) return undefined;

  const layers: Record<string, unknown>[] = [entry];
  for (const container of NESTED_CONTAINERS) {
    const nested = asRecord(entry[container]);
    if (nested) layers.push(nested);
  }

  let context: { value: number; via: string } | undefined;
  let output: { value: number; via: string } | undefined;
  for (const layer of layers) {
    context ??= readPlausibleNumber(layer, CONTEXT_KEYS);
    output ??= readPlausibleNumber(layer, OUTPUT_KEYS);
  }
  if (!context && !output) return undefined;

  return {
    modelId,
    ...(context ? { maxContextTokens: context.value, contextVia: context.via } : {}),
    ...(output ? { maxOutputTokens: output.value, outputVia: output.via } : {}),
  };
}

/**
 * 从 `/models` 响应体抽取全部可用的窗口事实。响应形状自适应（openai 兼容 `data[]`、
 * google/ollama `models[]`、裸数组）；无法识别时返回空数组（调用方 fail-open）。
 */
export function extractModelWindows(body: unknown): ModelWindowProbeHit[] {
  const entries = readEntries(body);
  if (!entries) return [];
  const hits: ModelWindowProbeHit[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const hit = probeEntry(entry);
    if (!hit || seen.has(hit.modelId)) continue;
    seen.add(hit.modelId);
    hits.push(hit);
  }
  return hits;
}

/** 区间常量再导出，便于调用方做同口径提示（避免各处硬编码）。 */
export { MODEL_WINDOW_MAX_TOKENS, MODEL_WINDOW_MIN_TOKENS };
