import type { GatewayChannelKey, GatewayMode } from "../../gateway/index.js";

export type CronTaskSchedule =
  | {
      type: "once";
      runAt: string;
    }
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    };

export type CronCreateSchedule =
  | CronTaskSchedule
  | {
      type: "delay";
      amount: number;
      unit: "second" | "minute" | "hour" | "day";
    };

export type CronSchedule = CronCreateSchedule;

export type CronTaskStatus = "scheduled" | "running" | "disabled";

export type CronTask = {
  schemaVersion: 1;
  taskId: string;
  message: string;
  schedule: CronTaskSchedule;
  status: CronTaskStatus;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  projectKey?: string;
  mode?: GatewayMode;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunId?: string;
  revision?: number;
  scheduleComputationVersion?: 2;
  originSessionKey?: string;
  originChannelKey?: GatewayChannelKey;
  /**
   * 任务创建来源：scheduled（cron_create 定时创建）/ run-now（cron_run_now 手动立即执行）。
   * 用于区分 run 记录的触发语义；run-now 孵化的一次性任务据此标记。
   */
  trigger?: "scheduled" | "run-now";
  /**
   * 指定该任务每次 run 使用的模型/provider（对齐 zcode automations 的 model/provider）。
   * 经 gateway submitTurn 的 modelRoute 传入；首个 turn 创建 session 时烘焙，
   * 同一任务多次 run 保持同一模型。provider 可选（缺省时由 session 默认 provider 兜底）。
   */
  modelRoute?: {
    provider?: string;
    model: string;
  };
  /**
   * 允许的最大 run 次数（含重试与手动 run-now 之外的自然触发）。达到后任务置 disabled 不再触发。
   * 不设置表示无限次。
   */
  maxRuns?: number;
  /** 已执行的 run 次数（自然触发计；失败重试不计入，见 retry.attempts）。 */
  runCount?: number;
  /** 失败重试策略（对齐 zcode automations 的 max_attempts）。未设置表示失败不重试。 */
  retry?: {
    /** 失败后最多重试次数（不含首次执行）。 */
    maxAttempts: number;
    /** 当前连续失败已重试次数。 */
    attempts?: number;
  };
  /** 最近一次 run 的错误（失败/重试耗尽后保留，供 cron_list 与后续 run 前检查）。 */
  lastError?: {
    code: string;
    message: string;
  };
  /** 覆盖结果投递渠道（默认沿用 channelKey="cron"）。 */
  deliveryChannel?: GatewayChannelKey;
  /**
   * 低谷时段偏好：置 true 时，该任务的触发时间被推迟到配置的低谷窗口
   * （cron.offPeakHours，如 [2,6]）内执行。用于错峰跑检索/报告等非交互任务。
   */
  offPeak?: boolean;
};

export type CronResultDelivery = {
  taskId: string;
  runId: string;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  originSessionKey?: string;
  originChannelKey?: GatewayChannelKey;
  projectKey?: string;
  outcome: CronRunOutcome;
  text: string;
  error?: {
    code: string;
    message: string;
  };
};

export type CronResultDeliveryHandler = (delivery: CronResultDelivery) => Promise<void> | void;

export type CronRunOutcome = "completed" | "failed" | "aborted" | "stopped";

export type CronRunRecord = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sessionKey: string;
  projectKey?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: CronRunOutcome;
  error?: {
    code: string;
    message: string;
  };
  /** 触发来源：scheduled（定时）/ run-now（手动立即执行）。 */
  trigger?: "scheduled" | "run-now";
  /** 本次 run 的重试序号（0 = 首次执行，1 = 第一次重试）。 */
  attempt?: number;
  /** 任务级 run 计数快照（第几次自然触发）。 */
  runNumber?: number;
};

export type CronCreateInput = {
  message: string;
  schedule: CronCreateSchedule;
  sessionKey?: string;
  channelKey?: GatewayChannelKey;
  projectKey?: string;
  mode?: GatewayMode;
  timezone?: string;
  modelRoute?: CronTask["modelRoute"];
  maxRuns?: number;
  retry?: CronTask["retry"];
  deliveryChannel?: GatewayChannelKey;
  trigger?: CronTask["trigger"];
  offPeak?: boolean;
};

export type CronCreateResult = {
  task: CronTask;
};

export type CronUpdateInput = {
  taskId: string;
  message: string;
  schedule: CronTaskSchedule;
  timezone?: string;
  projectKey?: string;
  expectedRevision: number;
};

export type CronUpdateResult =
  | {
      updated: true;
      task: CronTask;
    }
  | {
      updated: false;
      reason: "not_found" | "running" | "conflict";
    };

export type CronListInput = {
  projectKey?: string;
  includeHistory?: boolean;
  limit?: number;
};

export type CronListResult = {
  tasks: CronTask[];
  recentRuns?: CronRunRecord[];
};

export type CronDeleteInput = {
  taskId: string;
  projectKey?: string;
  stopRunning?: boolean;
};

export type CronDeleteResult = {
  deleted: boolean;
  stoppedRunId?: string;
};

export type CronStopInput = {
  taskId?: string;
  runId?: string;
  projectKey?: string;
};

export type CronStopResult = {
  stopped: boolean;
  taskId?: string;
  runId?: string;
  deletedOneTimeTask?: boolean;
};

export type CronRunNowInput = {
  taskId: string;
  projectKey?: string;
};

export type CronRunNowResult = {
  started: boolean;
  reason?: "not_found" | "already_running";
  taskId?: string;
};

export type CronRunOutcomeStatus = "completed" | "failed" | "running";

/**
 * Map a gateway `CronRunOutcome` (+ finishedAt presence) to a
 * UI-facing status. Centralised here so all clients share the same
 * mapping instead of reimplementing it.
 */
export function mapCronRunOutcome(
  outcome: CronRunOutcome | undefined | null,
  finishedAt: string | undefined | null,
): CronRunOutcomeStatus {
  if (!outcome) return finishedAt ? "completed" : "running";
  if (outcome === "completed") return "completed";
  if (outcome === "failed" || outcome === "aborted" || outcome === "stopped") return "failed";
  // CronRunOutcome 四值在上面的分支已穷尽；此行仅为持久化脏数据兜底。
  return "completed";
}
