/**
 * Build an `EdgeClawMemoryProvider` from `PilotMemoryConfig` + project root.
 * The factory is intentionally small — it just constructs the underlying
 * `EdgeClawMemoryService` with a sensible default rootDir and forwards the
 * relevant config fields.
 *
 * Returns `undefined` when the config is missing or `enabled === false`.
 *
 * Behavior parity goals:
 *   - The provider lives at the per-project scope (one DB per project root).
 *   - When `config.rootDir` is set we pin the workspace dir there; otherwise
 *     we anchor it under the project root so memory data lives next to the
 *     code it was captured from (matches legacy default).
 *   - `apiKey` for the LLM extractor is **lazily forwarded** — the user is
 *     expected to set it through env or sati.yaml; we never default
 *     credentials to anything other than what the user supplied.
 */

import { join } from "node:path";
import { EdgeClawMemoryService, type EdgeClawMemoryLlmOptions } from "edgeclaw-memory-core";
import type { ModelConfig, ModelProtocol } from "../../model/protocol/canonical.js";
import { EmbeddingRequestError } from "../../model/embedding/client.js";
import type { EmbeddingClient } from "../../model/embedding/types.js";
import type { PilotMemoryConfig } from "../../pilot/config/types.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import { defaultEmbeddingDir } from "../../knowledge/config.js";
import { EdgeClawMemoryProvider } from "./EdgeClawMemoryProvider.js";
import { MemorySemanticIndex, MemorySemanticServiceClosedError } from "./semantic-index.js";

export type CreateEdgeClawMemoryProviderOptions = {
  config: PilotMemoryConfig | undefined;
  modelConfig?: ModelConfig;
  /** Fallback model ref ("provider/model") when memory.model is not set. */
  agentModel?: string;
  projectRoot: string;
  /** Optional logger forwarded to the underlying service. */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** Optional `now` for deterministic tests. */
  now?: () => Date;
  telemetry?: TelemetryClient;
  /** 语义检索客户端（memory.embedding 解析产物）；缺省则关闭语义召回。 */
  embeddingClient?: EmbeddingClient;
  /** 向量持久化目录（默认 ~/.sati/knowledge/embeddings）。 */
  embeddingDir?: string;
};

export function createEdgeClawMemoryProviderFromConfig(
  options: CreateEdgeClawMemoryProviderOptions,
): { provider: EdgeClawMemoryProvider; service: EdgeClawMemoryService } | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;
  if (cfg.provider !== "edgeclaw") return undefined;

  const workspaceDir = options.projectRoot;
  const rootDir = cfg.rootDir;

  const llm = resolveMemoryLlm(cfg, options.modelConfig, options.agentModel);

  const service = new EdgeClawMemoryService({
    workspaceDir,
    rootDir,
    captureStrategy: cfg.captureStrategy,
    includeAssistant: cfg.includeAssistant,
    maxMessageChars: cfg.maxMessageChars,
    heartbeatBatchSize: cfg.heartbeatBatchSize,
    defaultIndexingSettings: cfg.schedule,
    source: "sati",
    logger: options.logger,
    llm,
    runtime: options.telemetry ? { telemetry: options.telemetry } : undefined,
  });

  // 语义召回（可选）：构造期注入避免循环依赖（索引需要 service，service 需要搜索函数）。
  if (options.embeddingClient && cfg.embedding?.indexMemory !== false) {
    const storePath = join(options.embeddingDir ?? defaultEmbeddingDir(), "memory.jsonl");
    const semanticIndex = new MemorySemanticIndex({
      service,
      client: options.embeddingClient,
      storePath,
      logger: options.logger,
    });
    service.setSemanticSearch(async (query, limit) => {
      const hits = await semanticIndex.search(query, limit);
      // 语义命中 id 即记忆文件 relativePath
      return hits.map(hit => ({ relativePath: hit.id, score: hit.score }));
    });
    // 后台预热（首次全量索引可能耗时秒级，不阻塞启动）。
    // embedding 服务随 Sati 启动存在就绪竞态：启动期网络不可达（retryable）时
    // 做有限重试，避免预热在服务就绪前失败一次后长期静默。关闭/非重试错误不重试。
    void warmupWithRetry(semanticIndex, options.logger, WARMUP_RETRY_ATTEMPTS);
  }

  const provider = new EdgeClawMemoryProvider({
    service,
    source: "sati",
    now: options.now,
    telemetry: options.telemetry,
  });

  return { provider, service };
}

/** 预热重试：最多尝试次数（含首次）。 */
const WARMUP_RETRY_ATTEMPTS = 3;
/** 重试间隔（毫秒），给 embedding 服务就绪留出时间。 */
const WARMUP_RETRY_DELAY_MS = 1500;

/**
 * 后台预热 + 有限重试。只对 retryable 的 embedding 网络错误重试；
 * 服务关闭（MemorySemanticServiceClosedError）与确定性错误直接落日志，不重试。
 */
async function warmupWithRetry(
  semanticIndex: MemorySemanticIndex,
  logger: CreateEdgeClawMemoryProviderOptions["logger"],
  attemptsLeft: number,
): Promise<void> {
  try {
    await semanticIndex.warmup();
  } catch (error) {
    if (error instanceof MemorySemanticServiceClosedError) {
      logger?.info?.("[sati] memory semantic index warmup cancelled: service closed");
      return;
    }
    const retryable = error instanceof EmbeddingRequestError && error.retryable;
    if (retryable && attemptsLeft > 1) {
      logger?.info?.(
        `[sati] memory semantic index warmup retryable failure (${attemptsLeft - 1} attempts left): ${error.message}`,
      );
      await new Promise(resolve => setTimeout(resolve, WARMUP_RETRY_DELAY_MS));
      return warmupWithRetry(semanticIndex, logger, attemptsLeft - 1);
    }
    logger?.warn?.(
      `[sati] memory semantic index warmup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveMemoryLlm(
  cfg: PilotMemoryConfig,
  modelConfig?: ModelConfig,
  agentModel?: string,
): EdgeClawMemoryLlmOptions | undefined {
  const modelRef = cfg.model || agentModel;
  if (!modelRef) return undefined;

  const sep = modelRef.indexOf("/");
  if (sep < 0) return undefined;

  const providerId = modelRef.slice(0, sep);
  const modelId = modelRef.slice(sep + 1);
  const providerEntry = modelConfig?.providers[providerId];

  const llm: EdgeClawMemoryLlmOptions = {
    provider: providerId,
    model: modelId,
    baseUrl: providerEntry?.url,
    apiKey: providerEntry?.apiKey,
  };
  const apiType = cfg.apiType ?? memoryApiTypeForProtocol(providerEntry?.protocol);
  if (apiType !== undefined) {
    llm.apiType = apiType as EdgeClawMemoryLlmOptions["apiType"];
  }
  return llm;
}

function memoryApiTypeForProtocol(
  protocol: ModelProtocol | undefined,
): PilotMemoryConfig["apiType"] | "openai-completions" | undefined {
  if (protocol === "anthropic" || protocol === "google") return protocol;
  if (protocol === "openai-responses") return "openai-responses";
  if (protocol === "openai") return "openai-completions";
  return undefined;
}
