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

export function createOpenAiEmbeddingClient(config: EmbeddingEndpointConfig): EmbeddingClient {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;
  const batchSize = config.batchSize ?? 32;
  let inferredDimensions: number | undefined = config.dimensions;

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
      const results: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const chunk = texts.slice(offset, offset + batchSize);
        const embeddings = await postEmbeddings(chunk);
        results.push(...embeddings);
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
        return false;
      }
    },
  };
}
