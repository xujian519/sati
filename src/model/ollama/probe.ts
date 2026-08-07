import { networkFetch } from "../../network/fetch.js";

/**
 * Ollama 本地模型自动识别。
 *
 * Sati 不再把 Ollama 的模型 id 写死在 catalog / 配置里——模型列表应当来自
 * 用户实际安装的模型。本模块提供：
 *
 *  - `probeOllamaInstalledModels(url)`：真实探测。优先 Ollama 原生
 *    `GET {origin}/api/tags`，兜底 OpenAI 兼容 `GET {baseUrl}/models`。
 *    任何失败（Ollama 未运行、超时、非 JSON）返回空数组且不抛错——
 *    Ollama 未运行时不应阻塞 Sati 启动。
 *  - `getCachedOllamaModels(url)`：同步读取进程级缓存（TTL 60s），供
 *    `parseModelConfig` 这类同步解析阶段直接使用。
 *  - `warmOllamaModels(url)` / `probeOllamaModelsCached(url)`：in-flight 去重
 *    的异步预热，成功后写入缓存。
 */

export type OllamaModelInfo = {
  id: string;
  displayName: string;
  /** Ollama 报告的原生上下文长度（tags.details.context_length），缺省时无。 */
  contextLength?: number;
};

// 缓存 TTL 仅为避免高频配置解析反复发起探测；它不是模型发现的延迟保证——
// 用户新 pull 的模型在 TTL 过期前的 reload 中不会出现，重启 gateway 立即生效。
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

const cache = new Map<string, { models: OllamaModelInfo[]; expiresAt: number }>();
const inFlight = new Map<string, Promise<OllamaModelInfo[]>>();

/** Ollama 服务 origin（`http://localhost:11434/v1` → `http://localhost:11434`）。 */
export function ollamaOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function normalizeModelId(raw: string): string {
  return raw.replace(/^models\//, "").trim();
}

function readContextLength(item: Record<string, unknown>): number | undefined {
  const details = item.details;
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>).context_length;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeTagsBody(body: unknown): OllamaModelInfo[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const rawModels = Array.isArray(record.models) ? record.models : [];
  const seen = new Set<string>();
  const models: OllamaModelInfo[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== "object") continue;
    const recordItem = item as Record<string, unknown>;
    const rawName = typeof recordItem.name === "string" ? recordItem.name : "";
    const id = normalizeModelId(rawName);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const info: OllamaModelInfo = { id, displayName: id };
    const contextLength = readContextLength(recordItem);
    if (contextLength !== undefined) info.contextLength = contextLength;
    models.push(info);
  }
  return models;
}

function normalizeModelsBody(body: unknown): OllamaModelInfo[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const rawModels = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const seen = new Set<string>();
  const models: OllamaModelInfo[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== "object") continue;
    const recordItem = item as Record<string, unknown>;
    const rawId =
      typeof recordItem.id === "string" ? recordItem.id : typeof recordItem.name === "string" ? recordItem.name : "";
    const id = normalizeModelId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof recordItem.display_name === "string" && recordItem.display_name.trim()
        ? recordItem.display_name.trim()
        : id;
    models.push({ id, displayName });
  }
  return models;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  try {
    const response = await networkFetch(url, { method: "GET" }, { timeoutMs, signal, fetchImpl });
    if (!response.ok) return null;
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  } catch {
    // 网络错误 / 超时 / 非 2xx：探测失败，按"未安装可识别模型"处理。
    return null;
  }
}

/**
 * 真实探测 Ollama 已安装模型。失败返回空数组，绝不抛错。
 *
 * 优先原生 `/api/tags`（Ollama 0.x 全版本支持、无需兼容层），
 * 未命中时兜底 OpenAI 兼容 `{baseUrl}/models`。
 */
export async function probeOllamaInstalledModels(
  baseUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<OllamaModelInfo[]> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBase) return [];

  const nativeUrl = `${ollamaOrigin(normalizedBase)}/api/tags`;
  const nativeBody = await fetchJson(nativeUrl, timeoutMs, options.signal, options.fetchImpl);
  const nativeModels = normalizeTagsBody(nativeBody);
  if (nativeModels.length > 0) return nativeModels;

  const compatibleUrl = `${normalizedBase}/models`;
  const compatibleBody = await fetchJson(compatibleUrl, timeoutMs, options.signal, options.fetchImpl);
  return normalizeModelsBody(compatibleBody);
}

/** 同步读取探测缓存；未命中或已过期返回 null。 */
export function getCachedOllamaModels(baseUrl: string): OllamaModelInfo[] | null {
  const entry = cache.get(baseUrl);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(baseUrl);
    return null;
  }
  return entry.models;
}

/** 触发异步探测（in-flight 去重），结果写入缓存。调用方无需等待。 */
export function warmOllamaModels(baseUrl: string): void {
  void probeOllamaModelsCached(baseUrl);
}

/** 探测并缓存，in-flight 去重；与 `warmOllamaModels` 的区别是返回 Promise。 */
export async function probeOllamaModelsCached(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<OllamaModelInfo[]> {
  const cached = getCachedOllamaModels(baseUrl);
  if (cached) return cached;

  const existing = inFlight.get(baseUrl);
  if (existing) return existing;

  const promise = probeOllamaInstalledModels(baseUrl, options)
    .then(models => {
      cache.set(baseUrl, { models, expiresAt: Date.now() + CACHE_TTL_MS });
      return models;
    })
    .finally(() => {
      inFlight.delete(baseUrl);
    });
  inFlight.set(baseUrl, promise);
  return promise;
}
