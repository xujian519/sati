/**
 * 从配置解析 EmbeddingClient。
 *
 * 支持两种形态（与 `memory.model` 的 "provider/model" 引用范式一致）：
 *   1. `provider` 形态：引用 model.providers 的 url/apiKey（复用现有
 *      provider 配置体系，含 Ollama 无鉴权占位特判）；
 *   2. `baseUrl` 形态：独立端点（url + apiKey + model 直配）。
 *
 * 校验失败返回 undefined + warning 诊断——语义检索是**可选增强**，
 * 未配置/失败时现有 keyword 检索路径原样工作。
 */

import type { PilotConfigDiagnostic, PilotMemoryEmbeddingConfig } from "../../pilot/config/types.js";
import type { ModelConfig } from "../protocol/canonical.js";
import { createOpenAiEmbeddingClient } from "./client.js";
import type { EmbeddingClient, EmbeddingEndpointConfig } from "./types.js";

export function resolveEmbeddingClient(
  cfg: PilotMemoryEmbeddingConfig | undefined,
  modelConfig?: ModelConfig,
  diagnostics?: PilotConfigDiagnostic[],
): EmbeddingClient | undefined {
  if (!cfg || cfg.enabled !== true) return undefined;
  const model = cfg.model?.trim();
  if (!model) return undefined;

  let endpoint: Pick<EmbeddingEndpointConfig, "baseUrl" | "apiKey"> | undefined;

  if (cfg.provider) {
    const providerEntry = modelConfig?.providers[cfg.provider];
    if (!providerEntry) {
      diagnostics?.push({
        code: "CONFIG_MEMORY_EMBEDDING_PROVIDER_NOT_FOUND",
        severity: "warning",
        message: `memory.embedding references unknown provider ${cfg.provider}.`,
        path: "memory.embedding.provider",
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
      code: "CONFIG_MEMORY_EMBEDDING_INVALID",
      severity: "warning",
      message: "memory.embedding requires either provider or baseUrl.",
      path: "memory.embedding",
      recoverable: true,
    });
    return undefined;
  }

  return createOpenAiEmbeddingClient({
    apiType: "openai",
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model,
    dimensions: cfg.dimensions,
    timeoutMs: cfg.timeoutMs,
    batchSize: cfg.batchSize,
  });
}
