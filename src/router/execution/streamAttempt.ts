import type { CanonicalModelEvent, CanonicalModelRequest, ModelProtocol, ModelRuntime } from "../../model/index.js";
import { ModelRequestError } from "../../model/index.js";
import type { RouterExecuteContext } from "../protocol/decision.js";
import type { RouterEventBus } from "../protocol/events.js";
import { createZeroUsageState, observeEventForZeroUsage, shouldRetryZeroUsage } from "../retry/zeroUsageRetry.js";

/**
 * 单 attempt 执行器：把 `modelRuntime.stream` 的原始事件透传出去，并在末尾追加一个
 * `{ kind: "outcome" }` 哨兵，携带重试与用量元数据。
 *
 * 债务 #343 / TD-ROUTER-002 建议的「抽单 attempt 执行器 + 重试判定纯函数」的前者。
 * 本文件另含流错误归类（`canonicalizeModelRequestError` / `isNetworkTransient` /
 * `classifyNetworkErrorCode` / `classifyRetryReason`）与可中止延时——它们都只服务于
 * 「一次 attempt」。
 *
 * 这里**不**做内容门控：是否已经向消费方吐过内容由调用方
 * `executeRouterDecision` 追踪（见其 `isContentEvent` 的长注释）。
 */

export type AttemptOutcome = {
  buffered: CanonicalModelEvent[];
  error?: import("../../model/index.js").CanonicalModelError;
  usage?: import("../../model/index.js").CanonicalUsage;
  shouldRetryZeroUsage: boolean;
};

/**
 * Live attempt — yields each model event the moment it arrives, then yields
 * a final `{ outcome }` sentinel with retry/usage metadata. The previous
 * implementation `await`-ed the entire stream into `buffered[]` before
 * returning, which silently broke streaming UX (TUI/CLI saw the assistant
 * text appear in one burst at the end of the turn).
 *
 * Trade-off: zero-usage retry and provider fallback can only fire BEFORE we
 * yield any content. If a provider crashes mid-stream after we've already
 * surfaced text, we can't transparently fall back without leaking duplicate
 * text. This matches OpenAI's / Anthropic's own clients.
 */
export async function* streamAttempt(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
  ctx: RouterExecuteContext,
  events: RouterEventBus,
): AsyncGenerator<{ kind: "event"; event: CanonicalModelEvent } | { kind: "outcome"; outcome: AttemptOutcome }> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../../model/index.js").CanonicalModelError | undefined;
  const abortSignal = ctx.abortSignal;

  try {
    for await (const event of modelRuntime.stream(request, {
      signal: abortSignal,
      onRetryProgress(progress) {
        events.emit({
          type: "sati_router_retry_progress",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          retryId: progress.retryId,
          attempt: progress.attempt,
          maxAttempts: progress.maxAttempts,
          delayMs: progress.delayMs,
          reason: progress.reason,
          provider: progress.provider,
          model: progress.model,
        });
      },
    })) {
      if (abortSignal?.aborted) {
        throwAbortError(abortSignal.reason);
      }
      observeEventForZeroUsage(state, event);
      buffered.push(event);
      if (event.type === "error") {
        providerError = event.error;
      }
      yield { kind: "event", event };
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const fromError = (error as { error?: import("../../model/index.js").CanonicalModelError })?.error;
    const protocol = protocolForProvider(modelRuntime, request.provider);
    providerError = fromError ??
      canonicalizeModelRequestError(error, request, protocol) ?? {
        provider: request.provider,
        protocol,
        code: classifyNetworkErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
        retryable: isNetworkTransient(error),
      };
  }

  yield {
    kind: "outcome",
    outcome: {
      buffered,
      error: providerError,
      usage: state.observedUsage,
      shouldRetryZeroUsage: shouldRetryZeroUsage(state),
    },
  };
}

function canonicalizeModelRequestError(
  error: unknown,
  request: CanonicalModelRequest,
  protocol: ModelProtocol,
): import("../../model/index.js").CanonicalModelError | undefined {
  if (!(error instanceof ModelRequestError)) {
    return undefined;
  }

  return {
    provider: request.provider,
    protocol,
    code: error.code,
    message: error.message,
    retryable: false,
    raw: error.details,
  };
}

export function protocolForProvider(modelRuntime: ModelRuntime, providerId: string): ModelProtocol {
  try {
    return modelRuntime.getProviderProtocol(providerId) ?? "openai";
  } catch {
    // 未知 provider：回退默认 openai 协议，后续由 validateModelRequest 兜底报错。
    return "openai";
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    throwAbortError(signal.reason);
  }
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

function throwAbortError(reason?: unknown): never {
  throw createAbortError(reason);
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}

function isNetworkTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("dns") ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}

function classifyNetworkErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const msg = error.message.toLowerCase();
  if (msg.includes("timeout") || error.name === "TimeoutError") return "timeout";
  if (msg.includes("abort") || error.name === "AbortError") return "aborted";
  return "network_error";
}

export function classifyRetryReason(
  errorCode: string,
): "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" {
  if (errorCode === "rate_limit_error") return "rate_limit";
  if (errorCode === "overloaded_error") return "overloaded";
  if (errorCode === "server_error") return "server_error";
  if (errorCode === "network_error" || errorCode === "timeout") return "network_error";
  return "server_error";
}
