/**
 * 重试退避延迟统一计算（P1 shared 收敛）。
 *
 * 纯函数：只算延迟，不读取 env、不 sleep。三种原实现语义在此收敛——
 *   - exponential（默认）：network/fetch.resolveRetryDelay（base × 2^attempt，
 *     抖动 floor(random × max(1, floor(delay × ratio)))，retry-after 优先封顶）
 *   - linear：router.calculateLiteLLMRetryDelay / model calculateRetryDelay
 *     （base × (attempt+1)，抖动 delay × ratio × random，retry-after 优先封顶）
 * 各调用方只保留超参（base/cap/jitterRatio 取值来源），公式实现全仓唯一。
 */
export type BackoffGrowth = "exponential" | "linear";

export type BackoffOptions = {
  /** 基础延迟（ms）。 */
  baseMs: number;
  /** 上限（ms）；linear 与 exponential 均封顶。 */
  capMs: number;
  /** 增长模式：exponential（默认，network/fetch 语义）或 linear。 */
  growth?: BackoffGrowth;
  /** 抖动比例（0–1）。exponential 默认 0.25（network/fetch 语义）。 */
  jitterRatio?: number;
};

/**
 * 计算第 `attempt` 次重试的等待延迟（ms）。
 *
 * @param attempt - 已发生的重试次数（0 起）。
 * @param options - 退避参数。
 * @param retryAfterMs - 服务端建议等待（HTTP retry-after / provider retryAfter），
 *   存在时优先使用并封顶 capMs。
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions, retryAfterMs?: number): number {
  const cap = options.capMs;
  if (retryAfterMs !== undefined) {
    return Math.min(cap, retryAfterMs);
  }
  const ratio = options.jitterRatio ?? 0.25;
  if (options.growth === "linear") {
    const deterministic = options.baseMs * (attempt + 1);
    const jitter = deterministic * ratio * Math.random();
    return Math.min(deterministic + jitter, cap);
  }
  const exponential = Math.min(cap, options.baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * ratio)));
  return Math.min(cap, exponential + jitter);
}
