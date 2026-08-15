/**
 * 重试状态追踪（阶段四 T4.2）。
 *
 * 为每次模型请求生成稳定的 retryId（同一 scope 内跨重试尝试稳定），记录重试
 * 调度（attempt/delay/reason），并暴露 providerRetryAfterMs 封顶语义。重试
 * 进度经 ModelStreamRetryProgress / sati_router_retry_progress 携带 retryId，
 * 配合 request_header 快照构成可审计的重试轨迹。跨进程「重启后扫描续算」
 * 依赖常驻执行的任务级重启扫描，属 always-on 范畴（见计划 §7 风险 4）。
 */
import { createHash, randomUUID } from "node:crypto";

export type RetryReason = "network_error" | "server_error" | "continuation" | "rate_limit";

/** 一次重试调度的记录。 */
export type RetrySchedule = {
  /** 稳定重试 id：同一 scope（provider/model/会话）内跨尝试稳定。 */
  retryId: string;
  provider: string;
  model: string;
  policyKey: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: RetryReason;
  scheduledAt: string;
};

export type RetryScheduleInput = Omit<RetrySchedule, "retryId" | "scheduledAt"> & {
  /** 生成 retryId 的 scope；缺省时每次调用生成随机 id。 */
  scope?: string;
};

/**
 * 依据 scope 生成稳定 retryId：同 scope 哈希一致；无 scope 时用随机 UUID。
 *
 * @param provider - provider id。
 * @param model - model id。
 * @param scope - 可选 scope（如 sessionId/turnId/请求内容摘要）。
 * @returns 稳定 retryId。
 */
export function createRetryId(provider: string, model: string, scope?: string): string {
  if (scope === undefined || scope.length === 0) {
    return randomUUID();
  }
  return createHash("sha256")
    .update(provider + "/" + model + "|" + scope)
    .digest("hex")
    .slice(0, 16);
}

/**
 * providerRetryAfterMs 封顶：尊重服务端建议但不超过部署上限（与
 * calculateRetryDelay 的语义一致，独立暴露供追踪/测试使用）。
 *
 * @param retryAfterMs - 服务端建议的等待时长（毫秒）。
 * @param maxDelayMs - 部署上限；缺省 8000ms。
 * @returns 封顶后的等待时长。
 */
export function capRetryAfterMs(retryAfterMs: number, maxDelayMs = 8000): number {
  return Math.min(retryAfterMs, maxDelayMs);
}

/**
 * 进程内重试状态追踪器：记录每次重试调度，供诊断/遥测快照。
 */
export class RetryStateTracker {
  private readonly schedules = new Map<string, RetrySchedule>();

  /**
   * 记录一次重试调度。
   *
   * @param input - 调度事实；retryId 按 scope 稳定生成。
   * @returns 完整调度记录（含 retryId 与时间戳）。
   */
  record(input: RetryScheduleInput): RetrySchedule {
    const retryId = createRetryId(input.provider, input.model, input.scope);
    const schedule: RetrySchedule = {
      ...input,
      retryId,
      scheduledAt: new Date().toISOString(),
    };
    this.schedules.set(retryId, schedule);
    return schedule;
  }

  /**
   * 读取一条调度记录。
   *
   * @param retryId - 稳定重试 id。
   * @returns 调度记录；未知 id 返回 undefined。
   */
  get(retryId: string): RetrySchedule | undefined {
    return this.schedules.get(retryId);
  }

  /** 全部调度快照（遥测/诊断用，调用方视为只读）。 */
  snapshot(): RetrySchedule[] {
    return [...this.schedules.values()];
  }
}
