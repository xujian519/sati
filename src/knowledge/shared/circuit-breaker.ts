/**
 * 熔断器（Circuit Breaker）——语义增强路径的故障保护。
 *
 * 语义召回/重排依赖外部 embedding 端点与离线向量索引，持续故障时
 * 若每个 turn 都重试，会白等 HTTP 超时拖慢对话。熔断器在连续失败
 * 达到阈值后打开（冷却期内直接跳过），冷却期满放行一次试探
 * （probing），成功复位、失败重新打开。关键词路径不经过熔断，
 * 保持"单个失败不影响其他"的既有降级哲学。
 *
 * 内部用单一状态字段驱动（closed/open/probing），冷却判定只在
 * 状态转移时计算一次，避免查询路径重复算时间。
 */

export type CircuitBreakerState = "closed" | "open" | "half-open";

export type CircuitBreakerOptions = {
  /** 连续失败多少次后打开（默认 3）。 */
  failureThreshold?: number;
  /** 打开后的冷却时长 ms（默认 120_000，2 分钟）。 */
  cooldownMs?: number;
  /** 时钟注入（测试用）。 */
  now?: () => number;
  logger?: { warn?: (...args: unknown[]) => void };
};

/** 内部状态：probing = half-open 试探已放行、在途。 */
type InternalState = "closed" | "open" | "probing";

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly logger?: { warn?: (...args: unknown[]) => void };

  private phase: InternalState = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  /** 对外状态：open 冷却期满但尚未试探时，对外表现为 half-open（等待试探）。 */
  get state(): CircuitBreakerState {
    if (this.phase === "closed") return "closed";
    if (this.phase === "probing") return "half-open";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  /** 是否允许发起一次调用。打开且冷却期内 → false（短路）；否则 true。 */
  allow(): boolean {
    if (this.phase === "closed") return true;
    if (this.phase === "probing") return false;
    // open：冷却期满 → 进入试探；未满 → 短路。
    if (this.now() - this.openedAt < this.cooldownMs) return false;
    this.phase = "probing";
    return true;
  }

  /** 调用成功后调用：复位计数与状态。 */
  success(): void {
    this.phase = "closed";
    this.failures = 0;
  }

  /** 调用失败后调用：计数 +1，达到阈值 → 打开；试探失败 → 重新打开。 */
  failure(): void {
    if (this.phase === "probing") {
      // 试探失败 → 重新 open，冷却重新计时。
      this.phase = "open";
      this.openedAt = this.now();
      this.failures = 1;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.phase = "open";
      this.openedAt = this.now();
      this.logger?.warn?.(
        `[knowledge] circuit breaker opened after ${this.failures} consecutive failures (cooldown ${this.cooldownMs}ms).`,
      );
    }
  }
}

/**
 * 受熔断保护的调用：短路或失败时返回 fallback，成功推进熔断状态。
 * 集中"allow → 调用 → success / failure"模板，调用方只需提供
 * 业务闭包、降级值与失败日志。
 */
export async function guarded<T>(
  breaker: CircuitBreaker,
  fallback: T,
  fn: () => Promise<T>,
  onError?: (error: unknown) => void,
): Promise<T> {
  if (!breaker.allow()) return fallback;
  try {
    const value = await fn();
    breaker.success();
    return value;
  } catch (error) {
    breaker.failure();
    onError?.(error);
    return fallback;
  }
}
