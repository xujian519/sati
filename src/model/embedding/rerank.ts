/**
 * 重排（rerank）客户端抽象——阶段 C。
 *
 * 召回（embedding top-k）之后的重排阶段：用 cross-encoder 对候选
 * 文档与 query 做 token 级交互打分，显著提升 top-N 精度（专利/法律
 * 场景尤其明显）。与 embedding 一致，**不内置模型**，走可配置端点。
 *
 * 默认实现兼容 HuggingFace TEI（text-embeddings-inference）的 `/rerank`：
 *   POST {baseUrl}/rerank  body { query, texts: string[] }
 *   响应 { "scores": number[] }（与 texts 对齐）
 * 同时兼容 Jina/Cohere 风格响应 { "results": [{ index, relevance_score }] }。
 *
 * 说明：TEI 单模型服务不接受 body.model；代理/多模型服务需要时在配置
 * 里显式提供 model 才发送该字段。
 */

import type { PilotConfigDiagnostic, PilotMemoryRerankConfig } from "../../pilot/config/types.js";
import type { ModelConfig } from "../protocol/canonical.js";

export type RerankEndpointConfig = {
  /** 端点基地址，如 http://localhost:8080（client 自行拼接 /rerank）。 */
  baseUrl: string;
  apiKey?: string;
  /** 模型名；TEI 单模型服务可留空（留空则不发送 model 字段）。 */
  model?: string;
  timeoutMs?: number;
  /**
   * 请求/响应风格：
   * - "tei"（默认）：TEI 风格 body { query, texts }，兼容 HuggingFace TEI 与
   *   Jina/Cohere 风格的 { results: [{index, relevance_score}] } 响应；
   * - "jina"：Jina/Cohere 风格 body { query, documents } + model（如 oMLX 的
   *   /v1/rerank，要求 model 与 documents 字段）。
   */
  style?: "tei" | "jina";
};

export interface RerankClient {
  /**
   * 对候选文档重排，返回按相关度降序的 { index, score }（index 指向
   * documents 入参下标，等价于排序后的顺序）。出错抛 `RerankRequestError`。
   */
  rerank(query: string, documents: string[], topN?: number): Promise<Array<{ index: number; score: number }>>;
  healthCheck(): Promise<boolean>;
}

export class RerankRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RerankRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析多种响应形态：TEI {scores} / Jina-Cohere {results}。 */
function parseRerankResults(json: unknown): Array<{ index: number; score: number }> {
  if (!isRecord(json)) {
    throw new RerankRequestError("Rerank response is not an object.");
  }
  if (Array.isArray(json.scores)) {
    return json.scores.map((score, index) => ({ index, score: typeof score === "number" ? score : 0 }));
  }
  if (Array.isArray(json.results)) {
    return json.results.map(item => {
      const record = isRecord(item) ? item : {};
      const score =
        typeof record.relevance_score === "number"
          ? record.relevance_score
          : typeof record.score === "number"
            ? record.score
            : 0;
      return { index: typeof record.index === "number" ? record.index : 0, score };
    });
  }
  throw new RerankRequestError('Rerank response missing "scores" or "results".');
}

export function createRerankClient(config: RerankEndpointConfig): RerankClient {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;
  const style = config.style ?? "tei";

  async function postRerank(query: string, texts: string[]): Promise<Array<{ index: number; score: number }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    /** 按指定风格构造请求体。 */
    function buildBody(useJinaStyle: boolean): Record<string, unknown> {
      // jina 风格（oMLX 等）要求 model + documents；tei 风格（默认）用 query + texts。
      const body: Record<string, unknown> = useJinaStyle ? { query, documents: texts } : { query, texts };
      if (config.model) body.model = config.model;
      return body;
    }

    /** 单次 POST；非 2xx 抛 RerankRequestError（附带响应体，供降级判定）。 */
    async function postOnce(
      useJinaStyle: boolean,
      signal: AbortSignal,
    ): Promise<Array<{ index: number; score: number }>> {
      const response = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(buildBody(useJinaStyle)),
        signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new RerankRequestError(
          `Rerank request failed (${response.status}): ${text.slice(0, 200)}`,
          response.status,
          response.status >= 500,
        );
      }
      const json = (await response.json()) as unknown;
      const results = parseRerankResults(json);
      if (results.length !== texts.length) {
        throw new RerankRequestError(
          `Rerank response count mismatch: expected ${texts.length}, got ${results.length}.`,
        );
      }
      return results;
    }

    try {
      try {
        return await postOnce(style === "jina", controller.signal);
      } catch (error) {
        // 自动降级：tei 风格遇到 OpenAI 兼容（oMLX 等）的 422——该服务要求
        // documents（可能还要 model）字段，tei 的 { query, texts } 会被拒。
        // 这是用户配置未显式指定 style（默认 tei）时的常见错配，无需用户改
        // 配置，自动用 jina 风格重试一次。
        if (style === "jina" || !(error instanceof RerankRequestError)) throw error;
        const wantsJinaBody = error.status === 422 && /documents|model/i.test(error.message);
        if (!wantsJinaBody) throw error;
        // 降级重试使用独立的超时预算：首请求可能已消耗大部分 timeoutMs（如服务端
        // 响应慢），若复用同一 controller 会立即被 abort。独立 controller 保证重试
        // 有完整 timeoutMs；外层 controller.abort() 仍会经由同 signal 传递取消。
        const retryController = new AbortController();
        const retryTimer = setTimeout(() => retryController.abort(), timeoutMs);
        const onOuterAbort = () => retryController.abort(controller.signal.reason);
        if (controller.signal.aborted) {
          retryController.abort(controller.signal.reason);
        } else {
          controller.signal.addEventListener("abort", onOuterAbort, { once: true });
        }
        try {
          return await postOnce(true, retryController.signal);
        } finally {
          clearTimeout(retryTimer);
          controller.signal.removeEventListener("abort", onOuterAbort);
        }
      }
    } catch (error) {
      if (error instanceof RerankRequestError) throw error;
      if (controller.signal.aborted) {
        throw new RerankRequestError(`Rerank request timed out after ${timeoutMs}ms.`, undefined, true);
      }
      throw new RerankRequestError(
        `Rerank request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async rerank(query: string, documents: string[], topN?: number): Promise<Array<{ index: number; score: number }>> {
      if (documents.length === 0) return [];
      const results = await postRerank(query, documents);
      const sorted = [...results].sort((a, b) => b.score - a.score);
      const limit = topN && topN > 0 ? Math.min(topN, sorted.length) : sorted.length;
      return sorted.slice(0, limit);
    },
    async healthCheck(): Promise<boolean> {
      try {
        await postRerank("ping", ["ping"]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function resolveRerankClient(
  cfg: PilotMemoryRerankConfig | undefined,
  modelConfig?: ModelConfig,
  diagnostics?: PilotConfigDiagnostic[],
): RerankClient | undefined {
  if (!cfg || cfg.enabled !== true) return undefined;

  let endpoint: { baseUrl: string; apiKey: string } | undefined;
  if (cfg.provider) {
    const providerEntry = modelConfig?.providers[cfg.provider];
    if (!providerEntry) {
      diagnostics?.push({
        code: "CONFIG_MEMORY_RERANK_PROVIDER_NOT_FOUND",
        severity: "warning",
        message: `memory.embedding.rerank references unknown provider ${cfg.provider}.`,
        path: "memory.embedding.rerank.provider",
        recoverable: true,
      });
      return undefined;
    }
    endpoint = { baseUrl: providerEntry.url, apiKey: providerEntry.apiKey };
  } else if (cfg.baseUrl) {
    endpoint = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey ?? "" };
  }

  if (!endpoint) {
    diagnostics?.push({
      code: "CONFIG_MEMORY_RERANK_INVALID",
      severity: "warning",
      message: "memory.embedding.rerank requires either provider or baseUrl.",
      path: "memory.embedding.rerank",
      recoverable: true,
    });
    return undefined;
  }

  return createRerankClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    style: cfg.style,
  });
}
