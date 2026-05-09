import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { CronRunRecord, CronRunOutcome, CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { computeNextRunAt } from "./CronSchedule.js";

export type CronActiveRun = {
  runId: string;
  taskId: string;
  sessionKey: string;
  scheduleType: CronTask["schedule"]["type"];
  stopRequested: boolean;
};

export type CronFireDependencies = {
  gateway: Gateway;
  store: CronTaskStore;
  now: () => Date;
  registerActiveRun: (run: CronActiveRun) => void;
  unregisterActiveRun: (runId: string) => CronActiveRun | undefined;
  getActiveRun: (runId: string) => CronActiveRun | undefined;
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
};

export class CronFire {
  constructor(private readonly deps: CronFireDependencies) {}

  async runTask(task: CronTask, runId: string): Promise<void> {
    const startedAt = this.deps.now();
    const activeRun: CronActiveRun = {
      runId,
      taskId: task.taskId,
      sessionKey: task.sessionKey,
      scheduleType: task.schedule.type,
      stopRequested: false,
    };
    this.deps.registerActiveRun(activeRun);
    await this.deps.store.putTask({
      ...task,
      status: "running",
      lastRunId: runId,
      updatedAt: startedAt.toISOString(),
    });

    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    try {
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey: task.sessionKey,
        channelKey: task.channelKey,
        projectKey: task.projectKey,
        message: task.message,
        mode: task.mode,
        runId,
      })) {
        await this.deps.store.appendRunEvent(runId, event);
        if (event.type === "error") {
          outcome = event.code === "agent_aborted" ? "aborted" : "failed";
          error = { code: event.code ?? "cron_run_failed", message: event.message };
        }
      }
    } catch (caught) {
      outcome = "failed";
      error = {
        code: "cron_run_failed",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    } finally {
      const currentActive = this.deps.getActiveRun(runId);
      if (currentActive?.stopRequested) {
        outcome = "stopped";
      }
      this.deps.unregisterActiveRun(runId);
      const finishedAt = this.deps.now();
      await this.deps.store.appendRun({
        schemaVersion: 1,
        runId,
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        projectKey: task.projectKey,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        outcome,
        error,
      });
      await this.updateTaskAfterRun(task, finishedAt, outcome).catch((updateError: unknown) => {
        this.deps.logger?.warn("cron task post-run update failed", {
          taskId: task.taskId,
          runId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      });
    }
  }

  private async updateTaskAfterRun(task: CronTask, finishedAt: Date, outcome: CronRunOutcome): Promise<void> {
    if (task.schedule.type === "once") {
      await this.deps.store.deleteTask(task.taskId);
      return;
    }
    const nextRunAt = computeNextRunAt(task.schedule, finishedAt)?.toISOString();
    await this.deps.store.updateTask(task.taskId, (current) => ({
      ...current,
      status: "scheduled",
      nextRunAt,
      updatedAt: finishedAt.toISOString(),
    }));
    void outcome;
  }
}
