/**
 * OpenAI 兼容 `/embeddings` 客户端实现。
 *
 * 兼容对象：Ollama（v0.5+，`ollama pull bge-m3` 后即用）、vLLM、
 * HuggingFace TEI、阿里云 DashScope 兼容模式等。请求/响应均遵循
 * OpenAI Embeddings API 形态：`POST {baseUrl}/embeddings`，
 * body `{ model, input: string[] }`，返回 `{ data: [{ embedding }] }`。
 */

import type { EmbeddingClient, EmbeddingEndpointConfig } from "./types.js";

export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

const HEALTH_CHECK_TEXT = "ping";
/** 同文本向量缓存上限（条）。bge-m3 1024 维 × 512 条约 2MB，FIFO 淘汰。 */
const VECTOR_CACHE_MAX_ENTRIES = 512;

export function createOpenAiEmbeddingClient(config: EmbeddingEndpointConfig): EmbeddingClient {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;
  const batchSize = config.batchSize ?? 32;
  let inferredDimensions: number | undefined = config.dimensions;

  // 同文本向量缓存：query 常跨调用方重复（patent/legal 双路共享同一 query、
  // 跨轮相似文本），命中即免一次网络往返（本地 Ollama 亦 ~100ms+）。确定性
  // embedding 模型下同文本→同向量，缓存安全；upsert 大文本一般不命中。
  const vectorCache = new Map<string, number[]>();

  function cacheSet(text: string, vector: number[]): void {
    if (vectorCache.size >= VECTOR_CACHE_MAX_ENTRIES) {
      const oldest = vectorCache.keys().next().value;
      if (oldest !== undefined) vectorCache.delete(oldest);
    }
    vectorCache.set(text, vector);
  }

  async function postEmbeddings(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new EmbeddingRequestError(
          `Embedding request failed (${response.status}): ${text.slice(0, 200)}`,
          response.status,
          response.status >= 500,
        );
      }
      const json = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const embeddings: number[][] = [];
      for (const entry of json.data ?? []) {
        const raw = entry.embedding;
        if (!Array.isArray(raw) || !raw.every(item => typeof item === "number")) {
          throw new EmbeddingRequestError("Embedding response contains a non-numeric vector.");
        }
        embeddings.push(raw as number[]);
      }
      if (embeddings.length !== input.length) {
        throw new EmbeddingRequestError(
          `Embedding response count mismatch: expected ${input.length}, got ${embeddings.length}.`,
        );
      }
      if (inferredDimensions === undefined && embeddings.length > 0 && embeddings[0]!.length > 0) {
        inferredDimensions = embeddings[0]!.length;
      }
      return embeddings;
    } catch (error) {
      if (error instanceof EmbeddingRequestError) throw error;
      if (controller.signal.aborted) {
        throw new EmbeddingRequestError(`Embedding request timed out after ${timeoutMs}ms.`, undefined, true);
      }
      throw new EmbeddingRequestError(
        `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const results: number[][] = new Array(texts.length);
      const missing: Array<{ index: number; text: string }> = [];
      texts.forEach((text, index) => {
        const cached = vectorCache.get(text);
        if (cached !== undefined) {
          results[index] = cached;
        } else {
          missing.push({ index, text });
        }
      });
      if (missing.length > 0) {
        const vectors = await embedBatched(missing.map(item => item.text));
        missing.forEach((item, k) => {
          // postEmbeddings 已保证响应条数与请求一致（不一致抛错），此处必存在
          results[item.index] = vectors[k]!;
          cacheSet(item.text, vectors[k]!);
        });
      }
      return results;
    },
    get dimensions(): number {
      return inferredDimensions ?? config.dimensions ?? 0;
    },
    async healthCheck(): Promise<boolean> {
      try {
        await postEmbeddings([HEALTH_CHECK_TEXT]);
        return true;
      } catch {
        // 探测失败即视为端点不可用，不冒泡（语义检索是可选的增强路径）。
        return false;
      }
    },
  };

  /** 按 batchSize 分批请求（嵌入路径内部，缓存未命中时调用）。 */
  async function embedBatched(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const chunk = texts.slice(offset, offset + batchSize);
      const embeddings = await postEmbeddings(chunk);
      results.push(...embeddings);
    }
    return results;
  }
}
