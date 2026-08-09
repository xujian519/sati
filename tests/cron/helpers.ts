import type { CronTask } from "../../src/cron/protocol/types.js";

/**
 * 构造一个最小合法 CronTask，测试可覆盖任意字段。
 * 供 tests/cron 内多个测试文件共享；migration 测试因操作旧格式原始对象
 * （Record<string, unknown>）而保留自己的 makeTask。
 */
export function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    schemaVersion: 1,
    taskId: "t1",
    message: "定时任务",
    schedule: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" },
    status: "scheduled",
    sessionKey: "cron:t1",
    channelKey: "cron",
    projectKey: "/tmp/project",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nextRunAt: "2026-08-05T00:00:00.000Z",
    scheduleComputationVersion: 2,
    ...overrides,
  };
}
