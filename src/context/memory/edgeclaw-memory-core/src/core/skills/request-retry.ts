// llm-extraction 的 HTTP 请求重试层（从 llm-extraction.ts 拆出，G1 纯函数部分）。
// 纯函数：无 IO、无外部状态，可独立单测。重试判定直接控制外部 LLM 费用与延迟，
// 语义必须保持（仅 8 个状态码可重试、最多 3 次、指数退避 1000×2^n）。

const REQUEST_RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_BASE_DELAY_MS = 1_000;

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorStatusCode(error: unknown): number | null {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function isTransientRequestError(error: unknown): boolean {
  const status = getErrorStatusCode(error);
  if (status !== null) return REQUEST_RETRYABLE_STATUS_CODES.has(status);
  if (isTimeoutError(error)) return true;
  if (!(error instanceof Error)) return false;
  return /(fetch failed|network|econnreset|econnrefused|etimedout|socket hang up|temporar|rate limit|too many requests)/i.test(
    error.message,
  );
}

function computeRetryDelayMs(attemptIndex: number): number {
  return DEFAULT_REQUEST_RETRY_BASE_DELAY_MS * 2 ** attemptIndex;
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return 30_000;
  if (timeoutMs <= 0) return null;
  return timeoutMs;
}

export {
  DEFAULT_REQUEST_MAX_ATTEMPTS,
  DEFAULT_REQUEST_RETRY_BASE_DELAY_MS,
  REQUEST_RETRYABLE_STATUS_CODES,
  computeRetryDelayMs,
  getErrorStatusCode,
  isTimeoutError,
  isTransientRequestError,
  resolveRequestTimeoutMs,
  sleep,
};
