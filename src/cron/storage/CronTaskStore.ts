import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayEvent } from "../../gateway/index.js";
import { createLogger } from "../../telemetry/index.js";
import { createJsonlRunWriter, type JsonlRunWriter } from "../../fs/jsonl-run-writer.js";
import type { CronRunRecord, CronTask } from "../protocol/types.js";
import { cronRunEventsPath, type CronPaths } from "./CronPaths.js";

const logger = createLogger("cron");

type CronTaskFile = {
  schemaVersion: 1;
  tasks: CronTask[];
};

const taskFileMutationTails = new Map<string, Promise<void>>();

export class CronTaskStore {
  private readonly runWriter: JsonlRunWriter;

  constructor(private readonly paths: CronPaths) {
    this.runWriter = createJsonlRunWriter(runId => cronRunEventsPath(this.paths, runId));
  }

  async listTasks(): Promise<CronTask[]> {
    return (await this.readTaskFile()).tasks;
  }

  async putTask(task: CronTask): Promise<void> {
    await this.mutateTaskFile(async file => {
      const index = file.tasks.findIndex(entry => entry.taskId === task.taskId);
      const nextTasks = [...file.tasks];
      if (index >= 0) {
        nextTasks[index] = task;
      } else {
        nextTasks.push(task);
      }
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(nextTasks) });
    });
  }

  async updateTask(taskId: string, update: (task: CronTask) => CronTask | undefined): Promise<CronTask | undefined> {
    return this.mutateTaskFile(async file => {
      let updated: CronTask | undefined;
      let changed = false;
      const tasks = file.tasks.flatMap(task => {
        if (task.taskId !== taskId) {
          return [task];
        }
        const next = update(task);
        updated = next;
        // 无变更（CAS 失败返回原引用）时跳过写盘，避免高频竞争下无谓 IO。
        if (next !== task) {
          changed = true;
        }
        return next ? [next] : [];
      });
      if (changed) {
        await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
      }
      return updated;
    });
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.mutateTaskFile(async file => {
      const tasks = file.tasks.filter(task => task.taskId !== taskId);
      if (tasks.length === file.tasks.length) {
        return false;
      }
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
      return true;
    });
  }

  async appendRun(record: CronRunRecord): Promise<void> {
    await mkdir(dirname(this.paths.runHistoryFile), { recursive: true });
    await appendFile(this.paths.runHistoryFile, `${JSON.stringify(record)}\n`, "utf-8");
  }

  async listRuns(limit = 50): Promise<CronRunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.runHistoryFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records = raw
      .split("\n")
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          const parsed = JSON.parse(line);
          const record = normalizeRun(parsed);
          return record ? [record] : [];
        } catch {
          // 坏行（残缺/非 JSON）→ 跳过该行；历史读取尽力而为，不阻塞 listing。
          return [];
        }
      });
    return records.slice(-Math.max(0, limit)).reverse();
  }

  /**
   * 追加一条 run 事件：按 runId 复用已打开的文件句柄（首次 open('a')，
   * 后续直接 write），避免每条事件重复 mkdir + open/close 三个 syscall。
   * 调用方保持 await 语义，事件顺序与落盘行为不变。
   */
  async appendRunEvent(runId: string, event: GatewayEvent): Promise<void> {
    await this.runWriter.append(runId, `${JSON.stringify({ schemaVersion: 1, runId, event })}\n`);
  }

  /** run 生命周期结束时主动关闭事件写入器（未调用则由空闲 TTL 兜底回收）。 */
  closeRun(runId: string): Promise<void> {
    return this.runWriter.close(runId);
  }

  private async readTaskFile(): Promise<CronTaskFile> {
    let raw: string;
    try {
      raw = await readFile(this.paths.tasksFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, tasks: [] };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CronTaskFile>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error("unexpected tasks.json shape");
      }
      return {
        schemaVersion: 1,
        tasks: parsed.tasks.flatMap(task => {
          const normalized = normalizeTask(task);
          return normalized ? [normalized] : [];
        }),
      };
    } catch (error) {
      // 损坏的 tasks.json：静默返回空数组会让下一次 mutation 把空数组写回，
      // 清空全部任务且无告警。改为把损坏文件备份为 .corrupt-<ts> 并告警，
      // 保留可恢复数据（fail-closed，不假装正常继续）。
      await this.backupCorruptTaskFile(error);
      return { schemaVersion: 1, tasks: [] };
    }
  }

  /** 把损坏的 tasks.json 移出原位（.corrupt-<ts>），防止后续 mutation 覆盖丢数据。 */
  private async backupCorruptTaskFile(reason: unknown): Promise<void> {
    const reasonText = reason instanceof Error ? reason.message : String(reason);
    const backupPath = `${this.paths.tasksFile}.corrupt-${Date.now()}`;
    try {
      await rename(this.paths.tasksFile, backupPath);
      logger.warn(`tasks.json corrupt (${reasonText}); backed up to ${backupPath}; resetting to empty task list`);
    } catch (backupError) {
      logger.warn(
        `tasks.json corrupt (${reasonText}) and backup to ${backupPath} failed: ${
          backupError instanceof Error ? backupError.message : String(backupError)
        }`,
      );
    }
  }

  private async writeTaskFile(file: CronTaskFile): Promise<void> {
    await mkdir(dirname(this.paths.tasksFile), { recursive: true });
    const tempPath = `${this.paths.tasksFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(file, null, 2), "utf-8");
      try {
        await rename(tempPath, this.paths.tasksFile);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          await copyFile(tempPath, this.paths.tasksFile);
        } else {
          throw err;
        }
      }
    } finally {
      // temp 大概率已被 rename 消费（ENOENT）；清理尽力而为，不覆盖主流程错误。
      await unlink(tempPath).catch(() => {});
    }
  }

  private async mutateTaskFile<T>(mutation: (file: CronTaskFile) => Promise<T>): Promise<T> {
    const key = this.paths.tasksFile;
    const previous = taskFileMutationTails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => mutation(await this.readTaskFile()));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    taskFileMutationTails.set(key, tail);
    try {
      return await operation;
    } finally {
      if (taskFileMutationTails.get(key) === tail) {
        taskFileMutationTails.delete(key);
      }
    }
  }
}

function sortTasks(tasks: CronTask[]): CronTask[] {
  return [...tasks].sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""));
}

function normalizeTask(value: unknown): CronTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CronTask>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.schedule ||
    typeof candidate.sessionKey !== "string" ||
    typeof candidate.channelKey !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return undefined;
  }
  if (candidate.schedule.type === "once" && typeof candidate.schedule.runAt !== "string") {
    return undefined;
  }
  if (candidate.schedule.type === "cron" && typeof candidate.schedule.expression !== "string") {
    return undefined;
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    message: candidate.message,
    schedule: candidate.schedule,
    status: normalizeTaskStatus(candidate.status),
    sessionKey: candidate.sessionKey,
    channelKey: candidate.channelKey,
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : undefined,
    mode: candidate.mode,
    timezone: typeof candidate.timezone === "string" ? candidate.timezone : undefined,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    nextRunAt: typeof candidate.nextRunAt === "string" ? candidate.nextRunAt : undefined,
    lastRunId: typeof candidate.lastRunId === "string" ? candidate.lastRunId : undefined,
    revision: Number.isSafeInteger(candidate.revision) && (candidate.revision as number) >= 0 ? candidate.revision : 0,
    scheduleComputationVersion: candidate.scheduleComputationVersion === 2 ? 2 : undefined,
    originSessionKey: typeof candidate.originSessionKey === "string" ? candidate.originSessionKey : undefined,
    originChannelKey: typeof candidate.originChannelKey === "string" ? candidate.originChannelKey : undefined,
    trigger: candidate.trigger === "run-now" ? "run-now" : "scheduled",
    modelRoute: normalizeModelRoute(candidate.modelRoute),
    maxRuns: normalizeNonNegativeInt(candidate.maxRuns),
    runCount: normalizeNonNegativeInt(candidate.runCount),
    retry: normalizeRetry(candidate.retry),
    lastError: normalizeError(candidate.lastError),
    deliveryChannel: typeof candidate.deliveryChannel === "string" ? candidate.deliveryChannel : undefined,
    offPeak: typeof candidate.offPeak === "boolean" ? candidate.offPeak : undefined,
  };
}

function normalizeTaskStatus(value: unknown): CronTask["status"] {
  if (value === "running") return "running";
  if (value === "disabled") return "disabled";
  return "scheduled";
}

function normalizeModelRoute(value: unknown): CronTask["modelRoute"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { provider?: unknown; model?: unknown };
  if (typeof candidate.model !== "string" || !candidate.model.trim()) return undefined;
  return {
    provider: typeof candidate.provider === "string" && candidate.provider.trim() ? candidate.provider : undefined,
    model: candidate.model,
  };
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  return undefined;
}

function normalizeRetry(value: unknown): CronTask["retry"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { maxAttempts?: unknown; attempts?: unknown };
  const maxAttempts = normalizeNonNegativeInt(candidate.maxAttempts);
  if (maxAttempts === undefined) return undefined;
  return {
    maxAttempts,
    attempts: normalizeNonNegativeInt(candidate.attempts),
  };
}

function normalizeError(value: unknown): CronTask["lastError"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return undefined;
  return { code: candidate.code, message: candidate.message };
}

function normalizeRun(value: unknown): CronRunRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CronRunRecord>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.runId !== "string" ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.sessionKey !== "string" ||
    typeof candidate.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    runId: candidate.runId,
    taskId: candidate.taskId,
    sessionKey: candidate.sessionKey,
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : undefined,
    startedAt: candidate.startedAt,
    finishedAt: typeof candidate.finishedAt === "string" ? candidate.finishedAt : undefined,
    outcome: candidate.outcome,
    error: candidate.error,
    trigger: candidate.trigger === "run-now" ? "run-now" : "scheduled",
    attempt: normalizeNonNegativeInt(candidate.attempt),
    runNumber: normalizeNonNegativeInt(candidate.runNumber),
  };
}
