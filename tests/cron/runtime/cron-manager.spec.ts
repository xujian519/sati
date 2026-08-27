import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Gateway } from "../../../src/gateway/index.js";
import { CronManager } from "../../../src/cron/runtime/CronManager.js";
import { resolveCronPaths } from "../../../src/cron/storage/CronPaths.js";
import { defaultCronConfig } from "../../../src/cron/config/parseCronConfig.js";

const FIXED_NOW = new Date("2026-08-05T10:00:00.000Z");
const FUTURE_RUN_AT = "2026-08-05T11:00:00.000Z";

function makeFakeGateway(): Gateway {
  return {
    closeSession: async () => {},
    abortTurn: async () => {},
  } as unknown as Gateway;
}

type ManagerHandle = {
  manager: CronManager;
  pilotHome: string;
  cleanup: () => Promise<void>;
};

async function makeManager(overrides: { pilotHome?: string } = {}): Promise<ManagerHandle> {
  const pilotHome = overrides.pilotHome ?? (await mkdtemp(join(tmpdir(), "cron-manager-")));
  const manager = new CronManager({
    config: defaultCronConfig(),
    pilotHome,
    now: () => FIXED_NOW,
  });
  manager.bindGateway(makeFakeGateway());
  return {
    manager,
    pilotHome,
    cleanup: async () => {
      await manager.stop().catch(() => undefined);
      await rm(pilotHome, { recursive: true, force: true });
    },
  };
}

function createInput(projectKey: string) {
  return {
    projectKey,
    message: "hello cron",
    schedule: { type: "once" as const, runAt: FUTURE_RUN_AT },
  };
}

test("createTask requires a projectKey", async () => {
  const { manager, cleanup } = await makeManager();
  try {
    await assert.rejects(
      () => manager.createTask({ message: "x", schedule: { type: "once", runAt: FUTURE_RUN_AT } }),
      /projectKey/,
    );
  } finally {
    await cleanup();
  }
});

test("ensureRuntime rolls back after a failed start and retries on next call", async () => {
  const { manager, pilotHome, cleanup } = await makeManager();
  try {
    const projectKey = join(pilotHome, "proj-alpha");
    const paths = resolveCronPaths({ pilotHome, projectKey });
    await mkdir(paths.projectDir, { recursive: true });
    // 障碍：tasks.json 是目录 → runtime.start() 读 store 时以 EISDIR 失败。
    await mkdir(paths.tasksFile);

    await manager.start(); // started = true；无已发现项目

    // 首次 createTask：ensureRuntime 内 runtime.start() 失败 → 错误上抛。
    await assert.rejects(() => manager.createTask(createInput(projectKey)));

    // 回滚断言：故障 runtime 已移出注册表——全量 listTasks 不再触达坏 store
    // （修复前僵尸 runtime 残留，此处会抛 EISDIR 且后续调用永不重试）。
    const all = await manager.listTasks();
    assert.deepEqual(all.tasks, []);

    // 解除障碍后重建 runtime 并成功。
    await rm(paths.tasksFile, { recursive: true });
    const result = await manager.createTask(createInput(projectKey));
    assert.equal(result.task.message, "hello cron");
    assert.equal(result.task.projectKey, projectKey);
  } finally {
    await cleanup();
  }
});

test("createTask routes per projectKey and listTasks aggregates across projects", async () => {
  const { manager, cleanup } = await makeManager();
  try {
    const alpha = await manager.createTask(createInput("/tmp/proj-alpha"));
    const beta = await manager.createTask(createInput("/tmp/proj-beta"));
    assert.equal(alpha.task.projectKey, "/tmp/proj-alpha");
    assert.equal(beta.task.projectKey, "/tmp/proj-beta");

    const all = await manager.listTasks();
    assert.deepEqual(all.tasks.map(task => task.projectKey).sort(), ["/tmp/proj-alpha", "/tmp/proj-beta"]);

    const onlyAlpha = await manager.listTasks({ projectKey: "/tmp/proj-alpha" });
    assert.equal(onlyAlpha.tasks.length, 1);
    assert.equal(onlyAlpha.tasks[0]!.projectKey, "/tmp/proj-alpha");
  } finally {
    await cleanup();
  }
});
