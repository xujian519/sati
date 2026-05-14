import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CronTaskStore,
  createCronRuntime,
  defaultCronConfig,
  resolveCronPaths,
  type CronCreateInput,
  type CronDeleteInput,
  type CronListInput,
  type CronStopInput,
} from "../../src/cron/index.js";
import type {
  Gateway,
  GatewayEvent,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
} from "../../src/gateway/index.js";

function makeGateway(): Gateway & {
  submitted: GatewaySubmitTurnInput[];
  aborts: Array<{ sessionKey: string; runId?: string }>;
  waitForSubmit(): Promise<void>;
} {
  let submitResolve: (() => void) | undefined;
  let abortResolve: (() => void) | undefined;
  const submitPromise = new Promise<void>((resolve) => {
    submitResolve = resolve;
  });
  const abortPromise = new Promise<void>((resolve) => {
    abortResolve = resolve;
  });
  const gateway = {
    submitted: [] as GatewaySubmitTurnInput[],
    aborts: [] as Array<{ sessionKey: string; runId?: string }>,
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      gateway.submitted.push(input);
      submitResolve?.();
      await abortPromise;
      yield { type: "error", code: "agent_aborted", message: "aborted", recoverable: true };
    },
    abortTurn: async (input: { sessionKey: string; runId?: string }) => {
      gateway.aborts.push(input);
      abortResolve?.();
    },
    listSessions: async (_input: ListSessionsInput): Promise<ListSessionsResult> => ({ sessions: [] }),
    resumeSession: async (input: { sessionKey: string }) => input,
    newSession: async (input: NewSessionInput) => ({ sessionKey: `${input.channelKey}:s_1` }),
    closeSession: async () => undefined,
    describeServer: async (): Promise<GatewayServerInfo> => ({ mode: "in_process" }),
    cronCreate: async (_input: CronCreateInput) => {
      throw new Error("not used");
    },
    cronList: async (_input: CronListInput) => {
      throw new Error("not used");
    },
    cronDelete: async (_input: CronDeleteInput) => {
      throw new Error("not used");
    },
    cronStop: async (_input: CronStopInput) => {
      throw new Error("not used");
    },
    cronRunNow: async () => {
      throw new Error("not used");
    },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => {
      throw new Error("not used");
    },
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input: { projectKey: string }) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
    waitForSubmit: () => submitPromise,
  };
  return gateway;
}

test("CronRuntime creates recurring tasks with a dedicated cron session", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-runtime-"));
  let now = new Date("2026-05-09T12:00:00.000Z");
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey: "/tmp/projects/sample",
      now: () => now,
      uuid: () => "run_or_task",
    });
    const gateway = makeGateway();
    runtime.bindGateway(gateway);
    const created = await runtime.createTask({
      message: "Run status check",
      schedule: { type: "cron", expression: "* * * * *" },
      projectKey: "/tmp/projects/sample",
    });
    assert.equal(created.task.projectKey, "/tmp/projects/sample");
    assert.equal(created.task.sessionKey, "cron:run_or_task");
    assert.equal(created.task.channelKey, "cron");
    now = new Date(created.task.nextRunAt!);
    await runtime.runTickOnce();
    await gateway.waitForSubmit();
    assert.equal(gateway.submitted[0].sessionKey, "cron:run_or_task");
    assert.equal(gateway.submitted[0].channelKey, "cron");
    assert.equal(gateway.submitted[0].projectKey, "/tmp/projects/sample");
    assert.equal(gateway.submitted[0].message, "Run status check");
    await runtime.stopTask({ taskId: created.task.taskId });
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronRuntime stop removes a running one-time task", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-stop-"));
  let now = new Date("2026-05-09T12:00:00.000Z");
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey: "/tmp/projects/sample",
      now: () => now,
      uuid: () => (now.getTime() === Date.parse("2026-05-09T12:00:00.000Z") ? "task_once" : "run_once"),
    });
    const gateway = makeGateway();
    runtime.bindGateway(gateway);
    const created = await runtime.createTask({
      message: "Run once",
      schedule: { type: "once", runAt: "2026-05-09T12:01:00.000Z" },
      projectKey: "/tmp/projects/sample",
    });
    assert.equal(created.task.sessionKey, "cron:task_once");
    now = new Date("2026-05-09T12:01:00.000Z");
    await runtime.runTickOnce();
    await gateway.waitForSubmit();
    const stopped = await runtime.stopTask({ taskId: created.task.taskId });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.deletedOneTimeTask, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await runtime.listTasks({})).tasks, []);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronRuntime migrates legacy task sessions on start", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-migrate-"));
  const projectKey = "/tmp/projects/sample";
  const now = new Date("2026-05-09T12:00:00.000Z");
  try {
    const store = new CronTaskStore(resolveCronPaths({ pilotHome, projectKey }));
    await store.putTask({
      schemaVersion: 1,
      taskId: "legacy-task",
      message: "Run status check",
      schedule: { type: "once", runAt: "2026-05-09T12:05:00.000Z" },
      status: "scheduled",
      sessionKey: "web:s_original",
      channelKey: "web",
      projectKey,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: "2026-05-09T12:05:00.000Z",
    });

    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey,
      now: () => now,
      uuid: () => "unused",
      store,
    });
    runtime.bindGateway(makeGateway());

    await runtime.start();
    const listed = await runtime.listTasks({});
    assert.equal(listed.tasks[0]?.sessionKey, "cron:legacy-task");
    assert.equal(listed.tasks[0]?.channelKey, "cron");
    await runtime.stop();
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
