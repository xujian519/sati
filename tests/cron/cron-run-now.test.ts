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
} from "../../src/cron/index.js";
import { mapCronRunOutcome } from "../../src/cron/protocol/types.js";
import type { Gateway, GatewayEvent, GatewayServerInfo, GatewaySubmitTurnInput, ListSessionsInput, ListSessionsResult, NewSessionInput } from "../../src/gateway/index.js";
import type { CronCreateInput, CronDeleteInput, CronListInput, CronRunNowInput, CronRunNowResult, CronStopInput } from "../../src/cron/protocol/types.js";

function makeGateway(): Gateway {
  return {
    async *submitTurn(_input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      yield { type: "turn_completed", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, serverToolTokens: 0 }, finishReason: "end_turn" };
    },
    abortTurn: async () => undefined,
    listSessions: async (_input: ListSessionsInput): Promise<ListSessionsResult> => ({ sessions: [] }),
    resumeSession: async (input: { sessionKey: string }) => input,
    newSession: async (input: NewSessionInput) => ({ sessionKey: `${input.channelKey}:s_1` }),
    closeSession: async () => undefined,
    describeServer: async (): Promise<GatewayServerInfo> => ({ mode: "in_process" }),
    cronCreate: async () => { throw new Error("not used"); },
    cronList: async () => { throw new Error("not used"); },
    cronDelete: async () => { throw new Error("not used"); },
    cronStop: async () => { throw new Error("not used"); },
    cronRunNow: async () => { throw new Error("not used"); },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => { throw new Error("not used"); },
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input: { projectKey: string }) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}

test("runTaskNow returns not_found for missing task", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-rn-"));
  try {
    const config = { ...defaultCronConfig(), enabled: true };
    const runtime = createCronRuntime({
      config,
      pilotHome,
      projectKey: "/tmp/test-project",
    });
    runtime.bindGateway(makeGateway());

    const result = await runtime.runTaskNow({ taskId: "nonexistent" });
    assert.equal(result.started, false);
    assert.equal(result.reason, "not_found");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("runTaskNow creates one-shot clone for existing scheduled task", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-rn-"));
  try {
    const config = { ...defaultCronConfig(), enabled: true };
    const runtime = createCronRuntime({
      config,
      pilotHome,
      projectKey: "/tmp/test-project",
    });
    runtime.bindGateway(makeGateway());

    await runtime.createTask({
      message: "Run unit tests",
      schedule: { type: "cron", expression: "0 12 * * *" },
    });

    const listBefore = await runtime.listTasks({});
    assert.equal(listBefore.tasks.length, 1);
    const taskId = listBefore.tasks[0]!.taskId;

    const result = await runtime.runTaskNow({ taskId });
    assert.equal(result.started, true);
    assert.equal(result.taskId, taskId);

    const listAfter = await runtime.listTasks({});
    assert.equal(listAfter.tasks.length, 2);
    const oneShot = listAfter.tasks.find((t) => t.schedule.type === "once");
    assert.ok(oneShot);
    assert.equal(oneShot!.message, "Run unit tests");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

// ---- mapCronRunOutcome -----------------------------------------------------

test("mapCronRunOutcome maps undefined outcome to running when no finishedAt", () => {
  assert.equal(mapCronRunOutcome(undefined, undefined), "running");
});

test("mapCronRunOutcome maps undefined outcome to completed when finishedAt", () => {
  assert.equal(mapCronRunOutcome(undefined, "2026-05-08T10:00:00Z"), "completed");
});

test("mapCronRunOutcome maps completed", () => {
  assert.equal(mapCronRunOutcome("completed", undefined), "completed");
});

test("mapCronRunOutcome maps failed/aborted/stopped to failed", () => {
  assert.equal(mapCronRunOutcome("failed", undefined), "failed");
  assert.equal(mapCronRunOutcome("aborted", undefined), "failed");
  assert.equal(mapCronRunOutcome("stopped", undefined), "failed");
});
