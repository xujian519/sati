import type { CronConfig } from "../config/parseCronConfig.js";
import type { CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { computeNextRunAt } from "./CronSchedule.js";
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
      }) as Promise<void>;
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
            await this.deps.store.deleteTask(task.taskId);
            return;
          }
          await this.deps.store.putTask({ ...task, nextRunAt, updatedAt: now.toISOString() });
          return;
        }

        if (task.scheduleComputationVersion === 2 && task.nextRunAt) {
          return;
        }
        const timezone = resolveCronTimezone(task.schedule.timezone, task.timezone, this.deps.config.timezone);
        const schedule = { ...task.schedule, timezone };
        const nextRunAt = computeNextRunAt(schedule, now, timezone)?.toISOString();
        await this.deps.store.putTask({
          ...task,
          schedule,
          timezone,
          status: "scheduled",
          nextRunAt,
          scheduleComputationVersion: 2,
          updatedAt: now.toISOString(),
        });
      }),
    );
  }

  private async delayTask(task: CronTask, now: Date): Promise<void> {
    const nextRunAt = new Date(now.getTime() + RETRY_DELAY_MS).toISOString();
    await this.deps.store.putTask({
      ...task,
      nextRunAt,
      updatedAt: now.toISOString(),
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
