import type { CronConfig } from "../config/parseCronConfig.js";
import type { CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { computeNextRunAt, CRON_SCHEDULE_COMPUTATION_VERSION, cronDayFieldsUseOr } from "./CronSchedule.js";
import type { CronFire } from "./CronFire.js";

const DEFAULT_IDLE_POLL_MS = 60_000;
/** 超并发任务被延迟后的重查间隔（原为 60s，缩短避免积压）。 */
const RETRY_DELAY_MS = 15_000;
const MIN_TIMER_MS = 250;

/**
 * 基于任务列表计算下一次唤醒延迟：
 * 取最早 `nextRunAt`（跳过 running 任务）与当前时间的差，上限空闲回退 60s；
 * 无任务/全部 running/无有效 nextRunAt 时回退 60s。
 * 纯函数，便于直接单元测试。
 */
export function computeCronDelayMs(tasks: CronTask[], nowMs: number): number {
  let earliest: number | undefined;
  for (const task of tasks) {
    if (task.status === "running" || !task.nextRunAt) continue;
    const at = new Date(task.nextRunAt).getTime();
    if (!Number.isNaN(at) && (earliest === undefined || at < earliest)) earliest = at;
  }
  if (earliest === undefined) return DEFAULT_IDLE_POLL_MS;
  return Math.min(DEFAULT_IDLE_POLL_MS, Math.max(0, earliest - nowMs));
}

export type CronSchedulerDependencies = {
  config: CronConfig;
  store: CronTaskStore;
  fire: CronFire;
  uuid: () => string;
  now: () => Date;
  activeRunCount: () => number;
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
};

export class CronScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private tickInProgress: Promise<void> | undefined;
  /** 最近一次 tick 读到的任务列表，用于精确计算下一次唤醒时间。 */
  private lastTasks: CronTask[] = [];

  constructor(private readonly deps: CronSchedulerDependencies) {}

  async start(): Promise<void> {
    if (!this.deps.config.enabled || this.stopped) {
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    await this.recalculateAllNextRuns();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.tickInProgress) {
      await this.tickInProgress.catch(() => undefined);
    }
  }

  poke(): void {
    if (this.stopped || !this.running || !this.deps.config.enabled) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleNextTick(0);
  }

  /** Public for tests; runs a single scheduler tick. */
  async runTickOnce(): Promise<void> {
    await this.tick();
  }

  private scheduleNextTick(delayMs?: number): void {
    if (this.stopped || !this.running || !this.deps.config.enabled) return;
    const waitMs = Math.max(MIN_TIMER_MS, delayMs ?? computeCronDelayMs(this.lastTasks, this.deps.now().getTime()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tickInProgress = this.tick().catch((error: unknown) => {
        this.deps.logger?.warn("cron scheduler tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void this.tickInProgress.then(() => {
        this.tickInProgress = undefined;
        this.scheduleNextTick();
      });
    }, waitMs);
  }

  private async tick(): Promise<void> {
    const now = this.deps.now();
    const tasks = await this.deps.store.listTasks();
    this.lastTasks = tasks;
    const dueTasks = tasks.filter(task => isDue(task, now));
    for (const task of dueTasks) {
      if (this.deps.activeRunCount() >= this.deps.config.maxConcurrentRuns) {
        await this.delayTask(task, now);
        continue;
      }
      const runId = this.deps.uuid();
      void this.deps.fire.runTask(task, runId).catch((error: unknown) => {
        this.deps.logger?.warn("cron fire failed", {
          taskId: task.taskId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async recalculateAllNextRuns(): Promise<void> {
    const now = this.deps.now();
    const tasks = await this.deps.store.listTasks();
    await Promise.all(
      tasks.map(async task => {
        if (task.schedule.type === "once") {
          if (task.nextRunAt) {
            return;
          }
          const nextRunAt = computeNextRunAt(task.schedule, now)?.toISOString();
          if (!nextRunAt) {
            await this.deps.store.updateTask(task.taskId, current =>
              matchesTaskSnapshot(current, task) ? undefined : current,
            );
            return;
          }
          await this.deps.store.updateTask(task.taskId, current => {
            if (!matchesTaskSnapshot(current, task)) return current;
            return {
              ...current,
              nextRunAt,
              revision: (current.revision ?? 0) + 1,
              updatedAt: now.toISOString(),
            };
          });
          return;
        }

        if (task.scheduleComputationVersion === CRON_SCHEDULE_COMPUTATION_VERSION && task.nextRunAt) {
          return;
        }
        const timezone = resolveCronTimezone(task.schedule.timezone, task.timezone, this.deps.config.timezone);
        const schedule = { ...task.schedule, timezone };
        const cachedRunAt = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
        const hasV2CachedRun = task.scheduleComputationVersion === 2 && Number.isFinite(cachedRunAt);
        // 只有两个受限日字段的语义从 AND 变成 OR；其余表达式沿用旧缓存，
        // 不走最坏一年的逐分钟搜索。
        const reuseCachedRun =
          hasV2CachedRun && (cachedRunAt <= now.getTime() || !cronDayFieldsUseOr(schedule.expression));
        const computedRunAt = reuseCachedRun ? undefined : computeNextRunAt(schedule, now, timezone);
        // OR 只会让触发提前，不会把 v2 已排定的触发推后；未来时间上的缓存
        // 可能是被并发上限推迟的逾期触发，须保留。
        const nextRunAt =
          hasV2CachedRun && (!computedRunAt || cachedRunAt <= computedRunAt.getTime())
            ? task.nextRunAt
            : computedRunAt?.toISOString();
        await this.deps.store.updateTask(task.taskId, current => {
          if (!matchesTaskSnapshot(current, task)) return current;
          return {
            ...current,
            schedule,
            timezone,
            status: "scheduled",
            nextRunAt,
            revision: (current.revision ?? 0) + 1,
            scheduleComputationVersion: CRON_SCHEDULE_COMPUTATION_VERSION,
            updatedAt: now.toISOString(),
          };
        });
      }),
    );
  }

  private async delayTask(task: CronTask, now: Date): Promise<void> {
    const nextRunAt = new Date(now.getTime() + RETRY_DELAY_MS).toISOString();
    await this.deps.store.updateTask(task.taskId, current => {
      if (!matchesTaskSnapshot(current, task) || current.status !== "scheduled") return current;
      return {
        ...current,
        nextRunAt,
        revision: (current.revision ?? 0) + 1,
        updatedAt: now.toISOString(),
      };
    });
  }
}

function isDue(task: CronTask, now: Date): boolean {
  if (task.status === "running") {
    return false;
  }
  if (!task.nextRunAt) {
    return false;
  }
  const dueAt = new Date(task.nextRunAt);
  return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= now.getTime();
}

function matchesTaskSnapshot(current: CronTask, snapshot: CronTask): boolean {
  return (
    current.status === snapshot.status &&
    (current.revision ?? 0) === (snapshot.revision ?? 0) &&
    current.nextRunAt === snapshot.nextRunAt &&
    current.lastRunId === snapshot.lastRunId
  );
}
