import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCronRuntime,
  defaultCronConfig,
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
    respondElicitation: async () => ({ delivered: false }),
    waitForSubmit: () => submitPromise,
  };
  return gateway;
}

test("CronRuntime creates recurring task that fires into the original session", async () => {
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
      sessionKey: "cli:s_original",
      channelKey: "cli",
      projectKey: "/tmp/projects/sample",
    });
    now = new Date(created.task.nextRunAt!);
    await runtime.runTickOnce();
    await gateway.waitForSubmit();
    assert.equal(gateway.submitted[0].sessionKey, "cli:s_original");
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
      sessionKey: "cli:s_original",
      channelKey: "cli",
      projectKey: "/tmp/projects/sample",
    });
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
