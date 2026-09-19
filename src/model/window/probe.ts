/**
 * provider `/models` 窗口探测执行器（issue #449 构件①）。
 *
 * 按需调用（设置页"探测窗口"或显式脚本），**不在配置加载路径上自动发起**：
 * 后台网络副作用会污染离线环境与测试（本仓已有 ollama 预热的前车之鉴，
 * 那次靠缓存+去重才压住 config reload 摆动）。探测结果落覆盖层，
 * 解析期即作为 `probe` 来源参与（下次 reload 生效）。
 *
 * 失败一律静默返回空：拿不到窗口是常态（标准 OpenAI 形状、未扩展中转站、
 * 自建服务都不返回窗口），调用方据此提示用户手动确认窗口。
 */
import { networkFetch } from "../../network/fetch.js";
import { buildProviderModelsEndpointCandidates, type ProviderEndpointProtocol } from "../providerEndpoint.js";
import { extractModelWindows, type ModelWindowProbeHit } from "./extract.js";
import type { ModelWindowStore } from "./store.js";

export const MODEL_WINDOW_PROBE_TIMEOUT_MS = 5_000;

export type ModelWindowProbeInput = {
  provider: string;
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** 各协议的鉴权/版本头。/models 是只读端点，不需要请求体。 */
export function buildModelWindowProbeHeaders(
  input: Pick<ModelWindowProbeInput, "protocol" | "apiKey" | "headers">,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...(input.headers ?? {}) };
  const apiKey = input.apiKey?.trim();
  if (apiKey && apiKey.length > 0) {
    if (input.protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    } else if (input.protocol === "google") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }
  return headers;
}

/**
 * 探测一个 provider 的模型窗口。依次尝试端点候选（版本段/无版本段），
 * 第一个能解析出窗口事实的响应胜出；全部失败返回空数组。
 */
export async function probeProviderModelWindows(input: ModelWindowProbeInput): Promise<ModelWindowProbeHit[]> {
  const timeoutMs = input.timeoutMs ?? MODEL_WINDOW_PROBE_TIMEOUT_MS;
  const headers = buildModelWindowProbeHeaders(input);
  const candidates = buildProviderModelsEndpointCandidates({ protocol: input.protocol, baseUrl: input.baseUrl });
  for (const url of candidates) {
    try {
      const response = await networkFetch(
        url,
        { method: "GET", headers },
        { timeoutMs, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) },
      );
      if (!response.ok) continue;
      const text = await response.text();
      if (!text) continue;
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        continue;
      }
      const hits = extractModelWindows(body);
      if (hits.length > 0) return hits;
    } catch {
      // 网络错误/超时/解析失败：试下一个候选，最终按"拿不到窗口"处理。
    }
  }
  return [];
}

export type ProbeAndRecordResult = {
  hits: ModelWindowProbeHit[];
  /** 实际写入覆盖层的条目数（拿不到任何维度的条目不计）。 */
  recorded: number;
};

/** 探测并把结果写进覆盖层（`source: probe`，与既有 observed 条目按取小合并）。 */
export async function probeAndRecordProviderModelWindows(
  input: ModelWindowProbeInput & { store: ModelWindowStore; now?: () => Date },
): Promise<ProbeAndRecordResult> {
  const hits = await probeProviderModelWindows(input);
  const updatedAt = (input.now?.() ?? new Date()).toISOString();
  let recorded = 0;
  for (const hit of hits) {
    if (hit.maxContextTokens === undefined && hit.maxOutputTokens === undefined) continue;
    const via = hit.contextVia ?? hit.outputVia;
    await input.store.record(input.provider, hit.modelId, {
      ...(hit.maxContextTokens !== undefined ? { maxContextTokens: hit.maxContextTokens } : {}),
      ...(hit.maxOutputTokens !== undefined ? { maxOutputTokens: hit.maxOutputTokens } : {}),
      source: "probe",
      updatedAt,
      ...(via !== undefined ? { via } : {}),
    });
    recorded += 1;
  }
  return { hits, recorded };
}
