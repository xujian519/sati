import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { CronResultDeliveryHandler, CronRunRecord, CronRunOutcome, CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { applyOffPeakWindow, computeNextRunAt, type OffPeakWindow } from "./CronSchedule.js";

export type CronActiveRun = {
  runId: string;
  taskId: string;
  sessionKey: string;
  scheduleType: CronTask["schedule"]["type"];
  stopRequested: boolean;
};

export type CronPhaseEventCallback = (event: {
  phase: "cron_started" | "cron_completed" | "cron_failed";
  runId: string;
  taskId: string;
  projectKey?: string;
  timestamp: string;
  title?: string;
  error?: { code: string; message: string };
}) => void;

export type CronTurnEventHandler = (sessionKey: string, channelKey: string, event: GatewayEvent) => void;

export type CronFireDependencies = {
  gateway: Gateway;
  store: CronTaskStore;
  now: () => Date;
  registerActiveRun: (run: CronActiveRun) => void;
  unregisterActiveRun: (runId: string) => CronActiveRun | undefined;
  getActiveRun: (runId: string) => CronActiveRun | undefined;
  runTimeoutMs: number;
  defaultTimezone: string;
  /** 低谷时段窗口（配置 cron.offPeakHours）；未配置则 offPeak 任务不生效。 */
  offPeakHours?: OffPeakWindow;
  releaseTaskSession: (task: CronTask) => Promise<void>;
  onResultDelivery?: CronResultDeliveryHandler;
  onTurnEvent?: CronTurnEventHandler;
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
  onPhaseEvent?: CronPhaseEventCallback;
};

export class CronFire {
  constructor(private readonly deps: CronFireDependencies) {}

  async runTask(taskSnapshot: CronTask, runId: string): Promise<void> {
    const startedAt = this.deps.now();
    const activeRun: CronActiveRun = {
      runId,
      taskId: taskSnapshot.taskId,
      sessionKey: taskSnapshot.sessionKey,
      scheduleType: taskSnapshot.schedule.type,
      stopRequested: false,
    };
    this.deps.registerActiveRun(activeRun);

    let task = taskSnapshot;
    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    let forcedFailure = false;
    let abortRequested = false;
    let startedRun = false;
    let assistantText = "";
    // 失败重试序号：0 = 首次执行，1 = 第一次重试。
    const attempt = task.retry?.attempts ?? 0;
    // 任务级 run 计数快照（自然触发第几次）；run-now 孵化的一次性任务以 runNumber=1 记。
    const runNumber = task.trigger === "run-now" ? 1 : (task.runCount ?? 0) + 1;
    try {
      let claimed = false;
      const currentTask = await this.deps.store.updateTask(taskSnapshot.taskId, current => {
        if (!matchesScheduledSnapshot(current, taskSnapshot)) {
          return current;
        }
        claimed = true;
        return {
          ...current,
          status: "running",
          lastRunId: runId,
          revision: (current.revision ?? 0) + 1,
          updatedAt: startedAt.toISOString(),
        };
      });
      if (!claimed || !currentTask) {
        outcome = "aborted";
        return;
      }
      task = currentTask;
      startedRun = true;
      this.deps.onPhaseEvent?.({
        phase: "cron_started",
        runId,
        taskId: task.taskId,
        projectKey: task.projectKey,
        timestamp: startedAt.toISOString(),
        title: firstLineTitle(task.message),
      });
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey: task.sessionKey,
        channelKey: task.channelKey,
        projectKey: task.projectKey,
        message: task.message,
        mode: task.mode ?? "bypassPermissions",
        // 仅当 provider 与 model 都齐备时才指定模型；否则交给 session 默认路由。
        modelRoute:
          task.modelRoute && task.modelRoute.provider
            ? { provider: task.modelRoute.provider, model: task.modelRoute.model }
            : undefined,
        runId,
        timeoutMs: this.deps.runTimeoutMs,
      })) {
        await this.deps.store.appendRunEvent(runId, event);
        this.forwardTurnEvent(task, event);
        if (event.type === "assistant_text_delta") {
          assistantText += event.text;
        }
        if (event.type === "elicitation_request" || event.type === "permission_request") {
          outcome = "failed";
          forcedFailure = true;
          error = {
            code: "cron_interaction_required",
            message: `Cron run requested unsupported user interaction through ${event.type}.`,
          };
          if (!abortRequested) {
            abortRequested = true;
            void this.deps.gateway
              .abortTurn({ sessionKey: task.sessionKey, runId, reason: "system:interaction_required" })
              .catch(() => undefined);
          }
          continue;
        }
        if (event.type === "error") {
          if (event.code === "turn_timeout") {
            outcome = "failed";
            forcedFailure = true;
            error = {
              code: "cron_run_timeout",
              message: event.message,
            };
            continue;
          }
          if (forcedFailure) {
            continue;
          }
          outcome = event.code === "agent_aborted" ? "aborted" : "failed";
          error = { code: event.code ?? "cron_run_failed", message: event.message };
        }
      }
    } catch (caught) {
      if (!forcedFailure) {
        outcome = "failed";
        error = {
          code: "cron_run_failed",
          message: caught instanceof Error ? caught.message : String(caught),
        };
      }
    } finally {
      const currentActive = this.deps.getActiveRun(runId);
      if (currentActive?.stopRequested) {
        outcome = "stopped";
      }
      this.deps.unregisterActiveRun(runId);
      // run 事件流结束：关闭复用 fd 的写入器（未关闭时 store 内 TTL 兜底）。
      void this.deps.store.closeRun(runId).catch(() => undefined);
    }
    // Note: no early `return` inside `finally` — it would swallow the caught error.
    if (!startedRun) {
      return;
    }
    const finishedAt = this.deps.now();
    await this.deps.store
      .appendRun({
        schemaVersion: 1,
        runId,
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        projectKey: task.projectKey,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        outcome,
        error,
        trigger: task.trigger ?? "scheduled",
        attempt,
        runNumber,
      })
      .catch((persistError: unknown) => {
        this.deps.logger?.warn("cron run terminal record write failed", {
          taskId: task.taskId,
          runId,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
    this.deps.onPhaseEvent?.({
      phase: outcome === "completed" ? "cron_completed" : "cron_failed",
      runId,
      taskId: task.taskId,
      projectKey: task.projectKey,
      timestamp: finishedAt.toISOString(),
      title: firstLineTitle(task.message),
      error,
    });
    await this.deliverResult(task, runId, outcome, assistantText, error).catch((deliveryError: unknown) => {
      this.deps.logger?.warn("cron result delivery failed", {
        taskId: task.taskId,
        runId,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      });
    });
    await this.updateTaskAfterRun(task, runId, finishedAt, attempt, runNumber, outcome, error).catch(
      (updateError: unknown) => {
        this.deps.logger?.warn("cron task post-run update failed", {
          taskId: task.taskId,
          runId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      },
    );
  }

  private forwardTurnEvent(task: CronTask, event: GatewayEvent): void {
    try {
      this.deps.onTurnEvent?.(task.sessionKey, task.channelKey, event);
    } catch (error) {
      this.deps.logger?.warn("cron turn event delivery failed", {
        taskId: task.taskId,
        runId: task.lastRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deliverResult(
    task: CronTask,
    runId: string,
    outcome: CronRunOutcome,
    assistantText: string,
    error: CronRunRecord["error"],
  ): Promise<void> {
    const text = outcome === "completed" ? assistantText.trim() : error?.message?.trim() || "Cron task failed.";
    const deliveryText = text || "定时任务已完成，但没有返回内容。";
    await this.deps.onResultDelivery?.({
      taskId: task.taskId,
      runId,
      sessionKey: task.sessionKey,
      // deliveryChannel 覆盖默认投递渠道（默认沿用 task.channelKey）。
      channelKey: task.deliveryChannel ?? task.channelKey,
      originSessionKey: task.originSessionKey,
      originChannelKey: task.originChannelKey,
      projectKey: task.projectKey,
      outcome,
      text: deliveryText,
      error,
    });
  }

  private async updateTaskAfterRun(
    task: CronTask,
    runId: string,
    finishedAt: Date,
    attempt: number,
    runNumber: number,
    outcome: CronRunOutcome,
    error: CronRunRecord["error"],
  ): Promise<void> {
    const failed = outcome === "failed";
    // interaction_required 等不可重试的失败：记录 lastError，但不触发重试。
    const retryable = failed && !isUnretryableError(error);
    if (retryable && shouldRetry(task, attempt)) {
      await this.retryTask(task, runId, finishedAt, attempt, error);
      return;
    }
    if (task.schedule.type === "once") {
      let deleted = false;
      await this.deps.store.updateTask(task.taskId, current => {
        if (!matchesRunningTask(current, task, runId)) {
          return current;
        }
        deleted = true;
        return undefined;
      });
      if (deleted) {
        await this.deps.releaseTaskSession(task);
      }
      return;
    }
    const timezone = resolveCronTimezone(task.schedule.timezone, task.timezone, this.deps.defaultTimezone);
    const schedule = { ...task.schedule, timezone };
    const rawNextRunAt = computeNextRunAt(schedule, finishedAt, timezone);
    // offPeak 任务把下一次触发推迟进低谷窗口。
    const nextRunAt = (
      task.offPeak && rawNextRunAt ? applyOffPeakWindow(rawNextRunAt, this.deps.offPeakHours, timezone) : rawNextRunAt
    )?.toISOString();
    // 成功计数：仅 completed 计入 runCount（失败重试由 attempt 单独跟踪，aborted/stopped 不计数）。
    const nextRunCount = outcome === "completed" ? runNumber : (task.runCount ?? 0);
    const maxRunsExhausted = task.maxRuns !== undefined && nextRunCount >= task.maxRuns;
    await this.deps.store.updateTask(task.taskId, current => {
      if (!matchesRunningTask(current, task, runId)) {
        return current;
      }
      return {
        ...current,
        schedule,
        timezone,
        status: maxRunsExhausted ? "disabled" : "scheduled",
        nextRunAt: maxRunsExhausted ? undefined : nextRunAt,
        runCount: nextRunCount,
        // 成功/终止后清空重试状态与最近错误；失败但耗尽重试则保留 lastError 供 cron_list 展示。
        retry: outcome === "completed" && current.retry ? { ...current.retry, attempts: 0 } : current.retry,
        lastError: failed ? error : undefined,
        revision: (current.revision ?? 0) + 1,
        scheduleComputationVersion: 2,
        updatedAt: finishedAt.toISOString(),
      };
    });
  }

  /** 按重试配额重排 nextRunAt（简单退避：attempt 越大间隔越远），并推进 retry.attempts。 */
  private async retryTask(
    task: CronTask,
    runId: string,
    finishedAt: Date,
    attempt: number,
    error: CronRunRecord["error"],
  ): Promise<void> {
    // once 型 schedule 无 timezone 字段，统一走顶层 task.timezone（与 updateTaskAfterRun 的 cron 路径一致地解析）。
    const timezone = resolveCronTimezone(task.timezone, undefined, this.deps.defaultTimezone);
    const schedule = { ...task.schedule, ...(task.schedule.type === "cron" ? { timezone } : {}) };
    const nextAttempt = attempt + 1;
    // 退避间隔：1min * 2^attempt（attempt=0 → 1min，attempt=1 → 2min…），上限 1 小时。
    const backoffMs = Math.min(60_000 * 2 ** Math.min(attempt, 6), 3_600_000);
    const nextRunAt = new Date(finishedAt.getTime() + backoffMs).toISOString();
    await this.deps.store.updateTask(task.taskId, current => {
      if (!matchesRunningTask(current, task, runId)) {
        return current;
      }
      return {
        ...current,
        schedule,
        timezone,
        status: "scheduled",
        nextRunAt,
        retry: {
          maxAttempts: task.retry?.maxAttempts ?? 0,
          attempts: nextAttempt,
        },
        lastError: error,
        revision: (current.revision ?? 0) + 1,
        scheduleComputationVersion: 2,
        updatedAt: finishedAt.toISOString(),
      };
    });
  }
}

/** 失败但无意义重试的错误（需要交互的失败重试只会再失败）。 */
function isUnretryableError(error: CronRunRecord["error"] | undefined): boolean {
  return error?.code === "cron_interaction_required";
}

function shouldRetry(task: CronTask, attempt: number): boolean {
  return task.retry?.maxAttempts !== undefined && attempt < task.retry.maxAttempts;
}

function firstLineTitle(message: string): string | undefined {
  return message.trimStart().split(/\r?\n/, 1)[0]?.trim().slice(0, 120);
}

function matchesScheduledSnapshot(current: CronTask, snapshot: CronTask): boolean {
  return (
    current.status === "scheduled" &&
    (current.revision ?? 0) === (snapshot.revision ?? 0) &&
    current.nextRunAt === snapshot.nextRunAt &&
    current.lastRunId === snapshot.lastRunId
  );
}

function matchesRunningTask(current: CronTask, claimedTask: CronTask, runId: string): boolean {
  return (
    current.status === "running" &&
    current.lastRunId === runId &&
    (current.revision ?? 0) === (claimedTask.revision ?? 0)
  );
}
