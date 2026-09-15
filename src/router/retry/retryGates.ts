/**
 * 重试判据（纯谓词）。
 *
 * 债务 #343 / TD-ROUTER-002 建议的「抽单 attempt 执行器 + 重试判定纯函数」的后者。
 * 这两个判据原本内联在 411 行的 `execute()` 闭包里，条件与副作用（发事件、算退避、
 * 等待）交缠在一起，无法单独验证「什么情况下该重试」。
 *
 * 抽成谓词后**条件表达式逐字搬走、短路顺序不变**，副作用仍留在
 * `execution/executeRouterDecision.ts` 里；`tests/router/retry/retry-gates.spec.ts`
 * 直接覆盖真值表。
 *
 * 两个判据共有的前提是 `!hasYieldedContent`：一旦向消费方吐出过内容事件
 * （text / thinking / tool），fallback 与重试都会产生重复文本，因此一律不重试。
 */

/** transient retry（同 provider 同 model 的瞬时错误重试）判据。 */
export type TransientRetryGate = {
  /** 本轮 attempt 是否已向消费方吐出过内容事件。 */
  hasYieldedContent: boolean;
  /** `isFallbackEligible(error)`：错误是否属于「换个端点/重发有意义」的一类。 */
  fallbackEligible: boolean;
  enabled: boolean;
  retryCount: number;
  maxRetries: number;
};

export function shouldTransientRetry(gate: TransientRetryGate): boolean {
  return !gate.hasYieldedContent && gate.fallbackEligible && gate.enabled && gate.retryCount < gate.maxRetries;
}

/** zero-usage retry（空白回合重试）判据。 */
export type ZeroUsageRetryGate = {
  /** 本轮 attempt 是否已向消费方吐出过内容事件。 */
  hasYieldedContent: boolean;
  enabled: boolean;
  /** `shouldRetryZeroUsage(state)`：上游确实结束但没有产出任何内容 token。 */
  attemptSaysRetry: boolean;
  attempt: number;
  maxAttempts: number;
};

export function shouldZeroUsageRetry(gate: ZeroUsageRetryGate): boolean {
  return !gate.hasYieldedContent && gate.enabled && gate.attemptSaysRetry && gate.attempt < gate.maxAttempts;
}
