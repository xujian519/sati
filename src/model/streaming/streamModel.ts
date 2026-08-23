import { normalizeModelError } from "../errors/normalizeModelError.js";
import { brandEnv, ENV_KEY } from "../../env.js";
import { readDurationEnvMs } from "../../shared/env/index.js";
import { createGoogleClient, type GoogleClientFactory } from "../providers/google/client.js";
import { parseGoogleResponse } from "../providers/google/response.js";
import type { GoogleRequestBody } from "../providers/google/request.js";
import { buildModelRequest } from "../request/buildModelRequest.js";
import { validateModelRequest } from "../request/validateModelRequest.js";
import { resolveApiKey, type CredentialEnv } from "../config/resolveCredentials.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelConfig, ProviderConfig } from "../protocol/canonical.js";
import {
  type CanonicalModelError,
  ModelConfigError,
  ModelProviderError,
  ModelRequestError,
  parseRetryAfterHeader,
} from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createGoogleStreamState, normalizeGoogleStreamEvent } from "../providers/google/stream.js";
import { normalizeProviderBaseUrl } from "../normalizeProviderBaseUrl.js";
import { buildProviderChatEndpointCandidates, isExpectedProviderResponseShape } from "../providerEndpoint.js";
import { NetworkFetchError, networkFetch } from "../../network/fetch.js";
import { computeBackoffDelay } from "../../shared/retry/index.js";
import { createRetryId } from "./retryState.js";
import { StreamingCheckpointManager } from "./StreamingCheckpoint.js";
// 流式 HTTP 传输常量单一来源（proxy 的 Undici 池共享，避免双源漂移）。
import {
  LITELLM_COMPLETION_HTTP_FALLBACK_MS,
  LITELLM_HTTP_CONNECTOR_LIMIT,
  LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
} from "./constants.js";
import { buildLiteLLMContinuationRequest } from "./continuationRequest.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  googleClientFactory?: GoogleClientFactory;
  signal?: AbortSignal;
  streamTimeoutMs?: number;
  onRetryProgress?: (progress: ModelStreamRetryProgress) => void;
};

export type ModelStreamRetryProgress = {
  /** 阶段四 T4.2：本次请求的稳定重试 id（同一 scope 内跨尝试稳定）。 */
  retryId: string;
  reason: "network_error" | "server_error" | "continuation";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  provider: string;
  model: string;
};

export const LITELLM_DEFAULT_MAX_RETRIES = 2;
export const LITELLM_DEFAULT_REQUEST_TIMEOUT_MS = 6_000_000;
// 转发导出 constants.ts（保持既有导出名；模块内部亦可直接引用）。
export { LITELLM_COMPLETION_HTTP_FALLBACK_MS, LITELLM_HTTP_CONNECTOR_LIMIT, LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS };
export const LITELLM_REPEATED_STREAMING_CHUNK_LIMIT = 100;
export const LITELLM_INITIAL_RETRY_DELAY_MS = 500;
export const LITELLM_MAX_RETRY_DELAY_MS = 8_000;
export const LITELLM_RETRY_JITTER = 0.75;
export const LITELLM_HTTP_CONNECTOR_LIMIT_PER_HOST = 500;
export const LITELLM_HTTP_TTL_DNS_CACHE_MS = 300_000;
export const LITELLM_HTTP_SO_KEEPALIVE = false;
export const LITELLM_HTTP_TCP_KEEPIDLE_SECONDS = 60;
export const LITELLM_HTTP_TCP_KEEPINTVL_SECONDS = 30;
export const LITELLM_HTTP_TCP_KEEPCNT = 5;
export const LITELLM_STREAM_MAX_DURATION_MS: number | undefined = readDurationEnvMs(
  process.env.LITELLM_MAX_STREAMING_DURATION_SECONDS,
  1000,
);

const DEFAULT_REQUEST_MAX_RETRIES = LITELLM_DEFAULT_MAX_RETRIES;

export async function complete(request: CanonicalModelRequest, config: ModelConfig, options: ModelRuntimeOptions = {}) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  const maxRetries = provider.retry?.requestMaxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;
  const retryBaseDelay = provider.retry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    if (provider.protocol === "google") {
      try {
        const raw = await sendGoogleCompleteRequest(provider, nonStreamingRequest, options);
        return parseGoogleResponse(raw, provider.id);
      } catch (error) {
        if (attempt < maxRetries && isRetryableRequestError(error)) {
          const delayMs = retryBaseDelay * (attempt + 1);
          warnCompleteRetry(error, attempt, maxRetries, delayMs);
          await delay(delayMs, options.signal);
          continue;
        }
        throw error;
      }
    }

    const body = buildModelRequest(nonStreamingRequest, config);
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);
    } catch (error) {
      if (attempt < maxRetries && isRetryableRequestError(error)) {
        const delayMs = retryBaseDelay * (attempt + 1);
        warnCompleteRetry(error, attempt, maxRetries, delayMs);
        await delay(delayMs, options.signal);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, raw, response.status));
    }

    const raw = await response.json();
    return parseModelResponse(provider.protocol, raw, provider.id);
  }

  throw new Error("complete() exhausted all retry attempts without a result.");
}

const DEFAULT_STREAM_MAX_RETRIES = LITELLM_DEFAULT_MAX_RETRIES;

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);
  const maxRetries = provider.retry?.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES;
  const retryBaseDelay = provider.retry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;
  // 阶段四 T4.2：稳定 retryId——同一请求（含会话 scope）内跨重试尝试稳定，
  // 经进度事件透出供审计/遥测关联。
  const retryScope =
    typeof streamingRequest.metadata?.turnId === "string" ? streamingRequest.metadata.turnId : undefined;
  const retryId = createRetryId(provider.id, streamingRequest.model, retryScope);

  yield {
    type: "request_started",
    provider: provider.id,
    model: streamingRequest.model,
    providerBaseUrl: normalizeProviderBaseUrl(provider.url),
    metadata: streamingRequest.metadata,
  };

  let currentRequest = streamingRequest;
  const checkpoint = new StreamingCheckpointManager();

  if (provider.protocol === "google") {
    yield* streamGoogleProviderRequest({
      request: currentRequest,
      provider,
      maxRetries,
      retryBaseDelay,
      retryId,
      checkpoint,
      options,
    });
    return;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    const body = buildModelRequest(currentRequest, config);
    await dumpRequestForDebug(body, currentRequest.model);
    let response: Response;
    try {
      response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal, options);
    } catch (error) {
      if (isRetryableStreamError(error) && checkpoint.interruption().phase !== "empty") {
        // 连接层失败但流已有部分内容：不再整体重试（会重复已收到的文本），
        // 以 streamInterruption 错误上抛，由 AgentLoop 恢复链续接。
        yield {
          type: "error",
          error: streamInterruptionError(provider, error, checkpoint),
        };
        return;
      }
      if (attempt < maxRetries && isRetryableStreamError(error)) {
        const delayMs = calculateRetryDelay(provider, attempt);
        emitModelRetryProgress(
          options,
          retryId,
          "network_error",
          attempt,
          maxRetries,
          delayMs,
          provider,
          currentRequest.model,
        );
        await delay(delayMs, options.signal);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const raw = await safeReadJson(response);
      const error = normalizeModelError(provider.id, provider.protocol, raw, response.status);
      if (error.retryAfterMs === undefined) {
        const headerMs = parseRetryAfterHeader(response.headers.get("retry-after"));
        if (headerMs !== undefined) {
          error.retryAfterMs = headerMs;
        }
      }
      if (error.retryable && attempt < maxRetries) {
        const delayMs = calculateRetryDelay(provider, attempt, error.retryAfterMs);
        emitModelRetryProgress(
          options,
          retryId,
          retryReasonForError(error.code),
          attempt,
          maxRetries,
          delayMs,
          provider,
          currentRequest.model,
        );
        await delay(delayMs, options.signal);
        continue;
      }
      if (error.retryable && checkpoint.interruption().phase !== "empty") {
        yield {
          type: "error",
          error: streamInterruptionError(provider, new ModelProviderError(error), checkpoint),
        };
        return;
      }
      yield { type: "error", error };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
      };
      return;
    }

    const state = createStreamNormalizerState(provider.protocol);
    let streamCompleted = false;
    let sawCompletionSentinel = false;

    const streamIdleTimeoutMs = resolveStreamIdleTimeout(provider, options);
    const streamGuard = createStreamGuard(provider);

    try {
      for await (const sseEvent of readServerSentEvents(response.body, options.signal, streamIdleTimeoutMs)) {
        streamGuard.checkDuration();
        if (sseEvent.type === "done") {
          sawCompletionSentinel = true;
          continue;
        }
        for (const event of normalizeStreamEvent(provider.protocol, sseEvent.data, state)) {
          if (event.type === "message_end") {
            sawCompletionSentinel = true;
          }
          if (event.type === "error") {
            // 流内 error chunk（openai/openai-responses/anthropic adapter 手工构造，
            // code/retryable 未经语义分类）在此统一归一化，保证 code/retryable/userHint
            // 对重试、router fallback、UI 元数据等下游一致；如 "terminated" 归为 timeout。
            throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, event.error));
          }
          streamGuard.observe(event);
          checkpoint.onEvent(event);
          yield event;
        }
      }
      streamGuard.checkDuration();
      if (!sawCompletionSentinel) {
        throw new IncompleteStreamError();
      }
      streamCompleted = true;
    } catch (error) {
      if (attempt < maxRetries && isRetryableStreamError(error) && checkpoint.canContinueText()) {
        currentRequest = buildLiteLLMContinuationRequest(currentRequest, checkpoint.get().partialText);
        // 不 reset：partialText 跨尝试累积，续接后的文本以 checkpoint 为基追加。
        const delayMs = calculateRetryDelay(provider, attempt, retryAfterMsForError(error));
        emitModelRetryProgress(
          options,
          retryId,
          "continuation",
          attempt,
          maxRetries,
          delayMs,
          provider,
          currentRequest.model,
        );
        await delay(delayMs, options.signal);
        continue;
      }

      if (isRetryableStreamError(error) && attempt < maxRetries && checkpoint.interruption().phase === "empty") {
        const delayMs = calculateRetryDelay(provider, attempt, retryAfterMsForError(error));
        emitModelRetryProgress(
          options,
          retryId,
          retryReasonForThrownError(error),
          attempt,
          maxRetries,
          delayMs,
          provider,
          currentRequest.model,
        );
        await delay(delayMs, options.signal);
        continue;
      }

      if (isRetryableStreamError(error)) {
        yield {
          type: "error",
          error: streamInterruptionError(provider, error, checkpoint),
        };
        return;
      }
      throw error;
    }

    if (streamCompleted) {
      return;
    }
  }
}

/** SATI_DUMP_REQUEST=1 时把请求体落盘到系统临时目录并打印路径（模型调试用）。 */
async function dumpRequestForDebug(body: unknown, modelId: string): Promise<void> {
  if (brandEnv(process.env, ENV_KEY.DUMP_REQUEST) !== "1") {
    return;
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dumpPath = path.join(os.tmpdir(), `sati_request_${Date.now()}.json`);
  fs.writeFileSync(dumpPath, JSON.stringify(body, null, 2));
  console.log(`[model-debug] Request dumped to ${dumpPath} (model=${modelId})`);
}

function warnCompleteRetry(error: unknown, attempt: number, maxRetries: number, delayMs: number): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[Sati] complete() retry: ${detail} (attempt ${attempt + 1}/${maxRetries}, delay=${delayMs}ms)`);
}

async function sendGoogleCompleteRequest(
  provider: ProviderConfig,
  request: CanonicalModelRequest,
  options: ModelRuntimeOptions,
): Promise<unknown> {
  try {
    const body = withGoogleAbortSignal<GoogleRequestBody>(
      buildModelRequest(request, {
        providers: { [provider.id]: provider },
      }) as GoogleRequestBody,
      options.signal,
    );
    const client = (options.googleClientFactory ?? createGoogleClient)(provider);
    return await client.models.generateContent(body);
  } catch (error) {
    throwIfGoogleAbort(error, options.signal);
    throw toProviderError(provider, error);
  }
}

async function* streamGoogleProviderRequest(params: {
  request: CanonicalModelRequest & { stream: boolean };
  provider: ProviderConfig;
  maxRetries: number;
  retryBaseDelay: number;
  retryId: string;
  checkpoint: StreamingCheckpointManager;
  options: ModelRuntimeOptions;
}): AsyncIterable<CanonicalModelEvent> {
  let currentRequest = params.request;

  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    throwIfAborted(params.options.signal);
    const streamAbort = new AbortController();
    const detachAbort = params.options.signal ? forwardAbort(params.options.signal, streamAbort) : undefined;
    try {
      const body = withGoogleAbortSignal<GoogleRequestBody>(
        buildModelRequest(currentRequest, {
          providers: { [params.provider.id]: params.provider },
        }) as GoogleRequestBody,
        streamAbort.signal,
      );
      await dumpRequestForDebug(body, currentRequest.model);

      // Google SDK 把 HttpOptions.timeout 应用于整个 HTTP 请求。流式场景下
      // 用下面的 per-read idle watchdog 兜底，因此既不传 idle 超时也不传
      // provider 请求超时给 SDK。
      const client = (params.options.googleClientFactory ?? createGoogleClient)({
        ...params.provider,
        timeoutMs: undefined,
      });
      const streamIdleTimeoutMs = resolveStreamIdleTimeout(params.provider, params.options);
      const abortForIdleTimeout = (error: StreamIdleTimeoutError) => streamAbort.abort(error);
      const stream = await withIdleTimeout(
        () => client.models.generateContentStream(body),
        streamIdleTimeoutMs,
        params.options.signal,
        abortForIdleTimeout,
      );
      const state = createGoogleStreamState();
      let sawTerminalEvent = false;
      const streamGuard = createStreamGuard(params.provider);

      while (true) {
        const { value: chunk, done } = await withIdleTimeout(
          () => stream.next(),
          streamIdleTimeoutMs,
          params.options.signal,
          abortForIdleTimeout,
        );
        if (done) {
          break;
        }
        throwIfAborted(params.options.signal);
        streamGuard.checkDuration();
        for (const event of normalizeGoogleStreamEvent(chunk, state)) {
          const terminalEvent = event.type === "message_end" || event.type === "error";
          if (terminalEvent) {
            sawTerminalEvent = true;
          }
          if (event.type === "error") {
            throw new ModelProviderError(event.error);
          }
          streamGuard.observe(event);
          params.checkpoint.onEvent(event);
          yield event;
          if (terminalEvent) {
            void stream.return(undefined).catch(() => undefined);
            return;
          }
        }
      }
      streamGuard.checkDuration();

      if (!sawTerminalEvent && !state.ended) {
        throw new IncompleteStreamError();
      }
      return;
    } catch (error) {
      throwIfGoogleAbort(error, params.options.signal);
      const providerError = toProviderError(params.provider, error);
      const retryable = isRetryableGoogleStreamError(providerError, error);
      if (attempt < params.maxRetries && retryable && params.checkpoint.canContinueText()) {
        currentRequest = buildLiteLLMContinuationRequest(currentRequest, params.checkpoint.get().partialText);
        // 不 reset：partialText 跨尝试累积，续接后的文本以 checkpoint 为基追加。
        const delayMs = calculateRetryDelay(params.provider, attempt);
        emitModelRetryProgress(
          params.options,
          params.retryId,
          "continuation",
          attempt,
          params.maxRetries,
          delayMs,
          params.provider,
          currentRequest.model,
        );
        await delay(delayMs, params.options.signal);
        continue;
      }

      if (retryable && attempt < params.maxRetries && params.checkpoint.interruption().phase === "empty") {
        const delayMs = calculateRetryDelay(params.provider, attempt);
        emitModelRetryProgress(
          params.options,
          params.retryId,
          "network_error",
          attempt,
          params.maxRetries,
          delayMs,
          params.provider,
          currentRequest.model,
        );
        await delay(delayMs, params.options.signal);
        continue;
      }

      yield {
        type: "error",
        error: retryable
          ? streamInterruptionError(params.provider, providerError, params.checkpoint)
          : providerError.error,
      };
      return;
    } finally {
      detachAbort?.();
    }
  }
}

function throwIfGoogleAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
  if (isAbortError(error)) {
    throw error;
  }
}

function isRetryableGoogleStreamError(providerError: ModelProviderError, raw: unknown): boolean {
  return providerError.error.retryable || isRetryableStreamError(raw);
}

function withGoogleAbortSignal<T extends object>(body: T, signal: AbortSignal | undefined): T {
  if (!signal) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const config =
    record.config && typeof record.config === "object"
      ? { ...(record.config as Record<string, unknown>), abortSignal: signal }
      : { abortSignal: signal };
  return { ...body, config };
}

function toProviderError(provider: ProviderConfig, error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  return new ModelProviderError(normalizeModelError(provider.id, provider.protocol, error, extractStatus(error)));
}

/**
 * 流在完成前中断（idle 超时/连接断开/网络错误）时产出的错误：在规范化
 * 错误上附加 `streamInterruption` 元数据（中断阶段 + 活动工具调用信息），
 * 供 AgentLoop 恢复链判断如何续接。错误本身带 retryable，但调用方
 * 不应整体重试（会重复已收到的文本），而是以本错误终止尝试。
 */
function streamInterruptionError(
  provider: ProviderConfig,
  error: unknown,
  checkpoint: StreamingCheckpointManager,
): CanonicalModelError {
  const providerError = toProviderError(provider, error).error;
  return { ...providerError, streamInterruption: checkpoint.interruption() };
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  if (typeof status === "number" && Number.isInteger(status)) {
    return status;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number" && Number.isInteger(responseStatus)) {
      return responseStatus;
    }
  }
  return undefined;
}

function isRetryableRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ModelProviderError) {
    return error.error.retryable;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed") ||
      msg.includes("timeout") ||
      msg.includes("etimedout") ||
      msg.includes("epipe") ||
      msg.includes("econnrefused") ||
      msg.includes("terminated")
    );
  }
  return false;
}

function isRetryableStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return error.error.retryable;
  }
  if (error instanceof StreamIdleTimeoutError) {
    return true;
  }
  if (error instanceof IncompleteStreamError) {
    return true;
  }
  if (error instanceof MaxStreamingDurationError) {
    return true;
  }
  if (error instanceof RepeatedStreamingChunkError) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed") ||
      msg.includes("aborted") ||
      msg.includes("timeout") ||
      msg.includes("epipe") ||
      msg.includes("econnrefused") ||
      msg.includes("terminated")
    );
  }
  return false;
}

function calculateRetryDelay(provider: ProviderConfig, attempt: number, retryAfterMs?: number): number {
  const baseDelayMs = provider.retry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;
  const maxDelayMs = provider.retry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS;
  const jitter = provider.retry?.jitter ?? LITELLM_RETRY_JITTER;
  return computeBackoffDelay(
    attempt,
    { baseMs: baseDelayMs, capMs: maxDelayMs, growth: "linear", jitterRatio: jitter },
    retryAfterMs,
  );
}

function retryAfterMsForError(error: unknown): number | undefined {
  return error instanceof ModelProviderError ? error.error.retryAfterMs : undefined;
}

function retryReasonForThrownError(error: unknown): ModelStreamRetryProgress["reason"] {
  if (error instanceof ModelProviderError) {
    return retryReasonForError(error.error.code);
  }
  return "network_error";
}

function retryReasonForError(code: string): ModelStreamRetryProgress["reason"] {
  return code === "server_error" ? "server_error" : "network_error";
}

function emitModelRetryProgress(
  options: ModelRuntimeOptions,
  retryId: string,
  reason: ModelStreamRetryProgress["reason"],
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  provider: ProviderConfig,
  model: string,
): void {
  options.onRetryProgress?.({
    retryId,
    reason,
    attempt: attempt + 1,
    maxAttempts,
    delayMs: Math.round(delayMs),
    provider: provider.id,
    model,
  });
}

type StreamGuard = {
  checkDuration: () => void;
  observe: (event: CanonicalModelEvent) => void;
};

function createStreamGuard(provider: ProviderConfig): StreamGuard {
  const startedAt = Date.now();
  const maxDurationMs = provider.retry?.maxStreamingDurationMs ?? LITELLM_STREAM_MAX_DURATION_MS;
  const repeatedChunkLimit = provider.retry?.repeatedChunkLimit ?? LITELLM_REPEATED_STREAMING_CHUNK_LIMIT;
  let lastText: string | undefined;
  let repeatedCount = 1;

  return {
    checkDuration() {
      if (maxDurationMs !== undefined && Date.now() - startedAt > maxDurationMs) {
        throw new MaxStreamingDurationError(maxDurationMs);
      }
    },
    observe(event) {
      this.checkDuration();
      if (event.type !== "text_delta" || typeof event.text !== "string" || event.text.length <= 2) {
        repeatedCount = 1;
        lastText = undefined;
        return;
      }
      if (event.text === lastText) {
        repeatedCount += 1;
      } else {
        lastText = event.text;
        repeatedCount = 1;
      }
      if (repeatedCount >= repeatedChunkLimit) {
        throw new RepeatedStreamingChunkError(event.text);
      }
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = LITELLM_COMPLETION_HTTP_FALLBACK_MS;

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
  options?: ModelRuntimeOptions,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const effectiveTimeoutMs = stream
    ? resolveStreamIdleTimeout(provider, options)
    : (provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const timeout = effectiveTimeoutMs
    ? setTimeout(
        () =>
          controller.abort(
            new NetworkFetchError(
              "network_timeout",
              stream
                ? `Stream idle timeout: no data received for ${effectiveTimeoutMs}ms`
                : `Model request timed out after ${effectiveTimeoutMs}ms.`,
            ),
          ),
        effectiveTimeoutMs,
      )
    : undefined;

  const finalBody = provider.extraBody ? { ...(body as Record<string, unknown>), ...provider.extraBody } : body;

  try {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: buildProviderHeaders(provider),
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    };
    return await sendWithEndpointFallback(provider, stream, transport, fetchOptions, effectiveTimeoutMs);
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
    throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detachAbort?.();
  }
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function sendWithEndpointFallback(
  provider: ProviderConfig,
  stream: boolean,
  transport: ModelTransport,
  fetchOptions: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  const endpoints = buildProviderChatEndpointCandidates({ protocol: provider.protocol, baseUrl: provider.url });
  let lastResponse: Response | undefined;
  for (const endpoint of endpoints) {
    const response = await networkFetch(endpoint, fetchOptions, {
      signal: fetchOptions.signal instanceof AbortSignal ? fetchOptions.signal : undefined,
      fetchImpl: transport === fetch ? undefined : transport,
      timeoutMs,
      retry: { maxRetries: 0, retryOnPost: true },
    });
    if (await shouldUseEndpointResponse(provider, response, stream, endpoints.length)) {
      return response;
    }
    lastResponse = response;
  }
  return lastResponse as Response;
}

function isEndpointFallbackStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 405;
}

async function shouldUseEndpointResponse(
  provider: ProviderConfig,
  response: Response,
  stream: boolean,
  endpointCount: number,
): Promise<boolean> {
  if (!response.ok) return endpointCount === 1 || !isEndpointFallbackStatus(response.status);
  if (stream || endpointCount === 1) return true;
  try {
    const body = await response.clone().json();
    return isExpectedProviderResponseShape(provider.protocol, body);
  } catch {
    return false;
  }
}

export function buildProviderHeaders(provider: ProviderConfig, env: CredentialEnv = process.env): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };

  // Defensive trim: parseModelConfig already strips whitespace from
  // apiKey, but a programmatic caller could hand a ProviderConfig in
  // here that bypassed the parser. A stray space in the header value
  // (`Bearer  sk-...`) is silently rejected by most providers as
  // `invalid_token`, so guard at the wire boundary too.
  const apiKey = resolveApiKeyAtRequest(provider, env);
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = headers.authorization ?? `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * 请求期 apiKey 解析（引用/值分离的消费端）：
 * - env 源（apiKeySource="env"）：每次请求从 apiKeyRaw 重新解析
 *   `${VAR}`——密钥轮换后下一次请求即生效，无需重启；解析失败抛错
 *   （与 parse 期行为一致，fail-loud 而非静默用旧值）；
 * - literal 源：用 parse 期已解析的 apiKey（trim 防御线内调用方直传）。
 */
function resolveApiKeyAtRequest(provider: ProviderConfig, env: CredentialEnv): string {
  try {
    if (provider.apiKeySource === "env" && provider.apiKeyRaw !== undefined) {
      return resolveApiKey(provider.apiKeyRaw, env);
    }
    return provider.apiKey.trim();
  } catch (error) {
    // 阶段四 T10：把凭证 seam 的稳定双码（missing_credential / invalid_credential）
    // 转为 ModelRequestError，使 router 的 canonicalizeModelRequestError 将其
    // 原样带入 CanonicalModelError.code，供 agent loop 分类与提示路由。
    if (error instanceof ModelConfigError) {
      throw new ModelRequestError(error.code, error.message, error.details);
    }
    throw error;
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 流 idle 超时与请求超时解耦：idle 缺省 600s（LITELLM_COMPLETION_HTTP_FALLBACK_MS），
// 不再回退到 provider.timeoutMs（那是整请求超时，语义不同）。
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = LITELLM_COMPLETION_HTTP_FALLBACK_MS;

class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Stream idle timeout: no data received for ${idleMs}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

class IncompleteStreamError extends Error {
  constructor() {
    super("Network stream ended before provider completion sentinel.");
    this.name = "IncompleteStreamError";
  }
}

class MaxStreamingDurationError extends Error {
  constructor(durationMs: number) {
    super(`Stream exceeded max streaming duration of ${durationMs}ms`);
    this.name = "MaxStreamingDurationError";
  }
}

class RepeatedStreamingChunkError extends Error {
  constructor(chunk: string) {
    super(`The model is repeating the same chunk = ${chunk}.`);
    this.name = "RepeatedStreamingChunkError";
  }
}

type ServerSentEvent = { type: "data"; data: unknown } | { type: "done" };

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // 分片累积用数组 + join，避免每 chunk 一次不可变字符串全量复制（O(n²) 拼接）。
  const parts: string[] = [];
  const effectiveIdleMs = idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const cancelReader = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };

  if (signal?.aborted) {
    cancelReader();
    throw createAbortError(signal.reason);
  }
  signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const readResult = await withIdleTimeout(() => reader.read(), effectiveIdleMs, signal);
      throwIfAborted(signal);
      const { value, done } = readResult;
      if (done) {
        parts.push(decoder.decode());
        break;
      }

      parts.push(decoder.decode(value, { stream: true }));
      const buffer = parts.join("");
      const chunks = buffer.split(/\n\n/);
      parts.length = 0;
      const tail = chunks.pop() ?? "";
      if (tail.length > 0) parts.push(tail);

      for (const chunk of chunks) {
        yield* parseServerSentEventChunk(chunk);
      }
    }

    const buffer = parts.join("");
    if (buffer.trim().length > 0) {
      for (const event of parseServerSentEventChunk(buffer)) {
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
  }
}

function* parseServerSentEventChunk(chunk: string): Iterable<ServerSentEvent> {
  const dataLines = chunk
    .split(/\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice("data:".length).trim());

  for (const data of dataLines) {
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      yield { type: "done" };
      continue;
    }
    yield { type: "data", data: JSON.parse(data) };
  }
}

/**
 * 给任意异步操作（SSE reader.read()、Google 生成器 next()）套 idle watchdog：
 * idleMs 内无结果即 reject StreamIdleTimeoutError；onIdleTimeout 可选回调
 * 供调用方同步中止底层操作（如 abort Google 流）。
 */
function withIdleTimeout<T>(
  operation: () => Promise<T>,
  idleMs: number,
  signal?: AbortSignal,
  onIdleTimeout?: (error: StreamIdleTimeoutError) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(createAbortError(signal?.reason));
      }
    };
    // timer 必须先于 addEventListener 初始化：onAbort 闭包引用它，const 声明
    // 在闭包定义之后、注册之前赋值，任何实际调用都发生在赋值完成之后。
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const error = new StreamIdleTimeoutError(idleMs);
        onIdleTimeout?.(error);
        // 三种结局（timer/abort/settle）都必须移除 listener：timer 分支
        // 之前漏移，listener 会留在调用方 signal 上直到该 signal 自身 abort。
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    }, idleMs);
    if (typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    operation().then(
      result => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      err => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      },
    );
  });
}

export function resolveStreamIdleTimeout(provider: ProviderConfig, options?: ModelRuntimeOptions): number {
  if (typeof options?.streamTimeoutMs === "number" && options.streamTimeoutMs > 0) {
    return options.streamTimeoutMs;
  }
  const retry = provider.retry;
  if (retry && typeof retry.streamIdleTimeoutMs === "number" && retry.streamIdleTimeoutMs > 0) {
    return retry.streamIdleTimeoutMs;
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
