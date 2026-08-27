import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../../src/gateway/index.js";
import type {
  CronResultDelivery,
  CronResultDeliveryHandler,
  CronRunRecord,
  CronTask,
} from "../../../src/cron/protocol/types.js";
import {
  CronFire,
  type CronActiveRun,
  type CronFireDependencies,
  type CronPhaseEventCallback,
} from "../../../src/cron/runtime/CronFire.js";
import type { CronTaskStore } from "../../../src/cron/storage/CronTaskStore.js";
import { makeTask } from "../helpers.js";

const FIXED_NOW = new Date("2026-08-05T10:00:00.000Z");

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FakeGatewayCalls = {
  submits: GatewaySubmitTurnInput[];
  aborts: Array<{ sessionKey: string; runId?: string; reason?: string }>;
  closes: Array<{ sessionKey: string; reason?: string }>;
};

function makeFakeGateway(events: GatewayEvent[] | (() => AsyncGenerator<GatewayEvent>)): {
  gateway: Gateway;
  calls: FakeGatewayCalls;
} {
  const calls: FakeGatewayCalls = { submits: [], aborts: [], closes: [] };
  const gateway = {
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncGenerator<GatewayEvent> {
      calls.submits.push(input);
      if (typeof events === "function") {
        yield* events();
      } else {
        for (const event of events) {
          yield event;
        }
      }
    },
    async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
      calls.aborts.push(input);
    },
    async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
      calls.closes.push(input);
    },
  } as unknown as Gateway;
  return { gateway, calls };
}

type FakeStoreState = {
  current: CronTask | undefined;
  eventCalls: Array<{ runId: string; event: GatewayEvent }>;
  closeCalls: string[];
  runRecords: CronRunRecord[];
  deleteCalls: string[];
  updateCalls: Array<{ taskId: string }>;
  updateResults: Array<CronTask | undefined>;
};

function makeFakeStore(
  initial?: CronTask,
  options: { appendRunError?: Error } = {},
): { store: CronTaskStore; state: FakeStoreState } {
  const state: FakeStoreState = {
    current: initial,
    eventCalls: [],
    closeCalls: [],
    runRecords: [],
    deleteCalls: [],
    updateCalls: [],
    updateResults: [],
  };
  const store = {
    async appendRunEvent(runId: string, event: GatewayEvent): Promise<void> {
      state.eventCalls.push({ runId, event });
    },
    async closeRun(runId: string): Promise<void> {
      state.closeCalls.push(runId);
    },
    async appendRun(record: CronRunRecord): Promise<void> {
      if (options.appendRunError) {
        throw options.appendRunError;
      }
      state.runRecords.push(record);
    },
    async deleteTask(taskId: string): Promise<boolean> {
      state.deleteCalls.push(taskId);
      state.current = undefined;
      return true;
    },
    async updateTask(taskId: string, updater: (task: CronTask) => CronTask | undefined): Promise<CronTask | undefined> {
      state.updateCalls.push({ taskId });
      if (state.current && state.current.taskId === taskId) {
        const updated = updater(state.current);
        state.updateResults.push(updated);
        if (updated) {
          state.current = updated;
        }
        return updated;
      }
      state.updateResults.push(undefined);
      return undefined;
    },
  } as unknown as CronTaskStore;
  return { store, state };
}

function makeFire(options: {
  task: CronTask;
  gateway: Gateway;
  store: CronTaskStore;
  now?: () => Date;
  defaultTimezone?: string;
  onResultDelivery?: CronResultDeliveryHandler;
  onPhaseEvent?: CronPhaseEventCallback;
  onTurnEvent?: CronFireDependencies["onTurnEvent"];
  activeRuns?: Map<string, CronActiveRun>;
  logger?: CronFireDependencies["logger"];
}): { fire: CronFire; activeRuns: Map<string, CronActiveRun>; releases: CronTask[] } {
  const activeRuns = options.activeRuns ?? new Map<string, CronActiveRun>();
  const releases: CronTask[] = [];
  const fire = new CronFire({
    gateway: options.gateway,
    store: options.store,
    now: options.now ?? (() => FIXED_NOW),
    registerActiveRun: run => {
      activeRuns.set(run.runId, run);
    },
    unregisterActiveRun: runId => {
      const run = activeRuns.get(runId);
      activeRuns.delete(runId);
      return run;
    },
    getActiveRun: runId => activeRuns.get(runId),
    runTimeoutMs: 60_000,
    defaultTimezone: options.defaultTimezone ?? "UTC",
    releaseTaskSession: async task => {
      releases.push(task);
    },
    onResultDelivery: options.onResultDelivery,
    onTurnEvent: options.onTurnEvent,
    logger: options.logger ?? { warn: () => undefined },
    onPhaseEvent: options.onPhaseEvent,
  });
  return { fire, activeRuns, releases };
}

// ---------------------------------------------------------------------------
// outcome 矩阵
// ---------------------------------------------------------------------------

describe("CronFire.runTask", () => {
  it("completed：正常事件流，追加记录、投递文本、触发完成事件", async () => {
    const task = makeTask();
    const { gateway, calls } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "你好，" },
      { type: "assistant_text_delta", text: "世界" },
    ]);
    const { store, state } = makeFakeStore(task);
    const phases: string[] = [];
    const deliveries: CronResultDelivery[] = [];
    const { fire } = makeFire({
      task,
      gateway,
      store,
      onPhaseEvent: event => phases.push(event.phase),
      onResultDelivery: delivery => {
        deliveries.push(delivery);
      },
    });

    await fire.runTask(task, "run-1");

    // submitTurn 参数
    assert.equal(calls.submits.length, 1);
    assert.equal(calls.submits[0]!.message, task.message);
    assert.equal(calls.submits[0]!.runId, "run-1");
    assert.equal(calls.submits[0]!.mode, "bypassPermissions");
    assert.equal(calls.submits[0]!.timeoutMs, 60_000);
    // 每条事件都落盘，事件写入器关闭
    assert.equal(state.eventCalls.length, 3);
    assert.deepEqual(state.closeCalls, ["run-1"]);
    // 运行记录
    assert.equal(state.runRecords.length, 1);
    assert.equal(state.runRecords[0]!.outcome, "completed");
    assert.equal(state.runRecords[0]!.error, undefined);
    assert.equal(state.runRecords[0]!.runId, "run-1");
    // 阶段事件
    assert.deepEqual(phases, ["cron_started", "cron_completed"]);
    // 结果投递
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.outcome, "completed");
    assert.equal(deliveries[0]!.text, "你好，世界");
  });

  it("completed：turn 事件经 onTurnEvent 转发（含任务会话标识）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "你好，" },
      { type: "assistant_text_delta", text: "世界" },
    ]);
    const { store } = makeFakeStore(task);
    const forwarded: Array<{ sessionKey: string; channelKey: string; event: GatewayEvent }> = [];
    const { fire } = makeFire({
      task,
      gateway,
      store,
      onTurnEvent: (sessionKey, channelKey, event) => {
        forwarded.push({ sessionKey, channelKey, event });
      },
    });

    await fire.runTask(task, "run-1");

    assert.equal(forwarded.length, 3);
    assert.deepEqual(
      forwarded.map(item => item.event),
      [
        { type: "turn_started", runId: "run-1" },
        { type: "assistant_text_delta", text: "你好，" },
        { type: "assistant_text_delta", text: "世界" },
      ],
    );
    // 事件携带任务自身的会话/渠道标识，供广播按会话路由
    for (const item of forwarded) {
      assert.equal(item.sessionKey, task.sessionKey);
      assert.equal(item.channelKey, task.channelKey);
    }
  });

  it("onTurnEvent 抛异常不中断 run，仅记录警告", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "你好" },
    ]);
    const { store, state } = makeFakeStore(task);
    const warnings: string[] = [];
    const { fire } = makeFire({
      task,
      gateway,
      store,
      onTurnEvent: () => {
        throw new Error("forwarder down");
      },
      logger: { warn: message => warnings.push(message) },
    });

    await fire.runTask(task, "run-1");

    assert.equal(state.runRecords[0]!.outcome, "completed");
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(message => message.includes("cron turn event delivery failed")));
  });

  it("completed 且无返回文本时投递默认文案", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([{ type: "turn_started", runId: "run-1" }]);
    const { store } = makeFakeStore(task);
    const deliveries: CronResultDelivery[] = [];
    const { fire } = makeFire({
      task,
      gateway,
      store,
      onResultDelivery: delivery => {
        deliveries.push(delivery);
      },
    });
    await fire.runTask(task, "run-1");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.text, "定时任务已完成，但没有返回内容。");
  });

  it("turn_timeout 事件 → failed（code=cron_run_timeout）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "error", message: "turn exceeded 60s", code: "turn_timeout", recoverable: true },
    ]);
    const { store, state } = makeFakeStore(task);
    const phases: string[] = [];
    const { fire } = makeFire({ task, gateway, store, onPhaseEvent: event => phases.push(event.phase) });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "cron_run_timeout");
    assert.equal(state.runRecords[0]!.error?.message, "turn exceeded 60s");
    assert.deepEqual(phases, ["cron_started", "cron_failed"]);
  });

  it("普通 error 事件 → failed（透传 error code）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "error", message: "tool exploded", code: "tool_failed", recoverable: true },
    ]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "tool_failed");
    assert.equal(state.runRecords[0]!.error?.message, "tool exploded");
  });

  it("error 无 code → failed（兜底 cron_run_failed）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "error", message: "generic", recoverable: true },
    ]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "cron_run_failed");
  });

  it("agent_aborted 事件 → aborted", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "error", message: "agent stopped", code: "agent_aborted", recoverable: false },
    ]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "aborted");
    assert.equal(state.runRecords[0]!.error?.code, "agent_aborted");
  });

  it("elicitation_request → failed（interaction_required）并 abortTurn，后续 error 被忽略", async () => {
    const task = makeTask();
    const { gateway, calls } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      {
        type: "elicitation_request",
        requestId: "q1",
        toolCallId: "tc1",
        toolName: "ask_user_question",
        questions: [],
      } as GatewayEvent,
      // forcedFailure 置位后，后续 error 事件被跳过
      { type: "error", message: "ignored", code: "boom", recoverable: true },
    ]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "cron_interaction_required");
    assert.match(state.runRecords[0]!.error?.message ?? "", /elicitation_request/);
    assert.equal(calls.aborts.length, 1);
    assert.equal(calls.aborts[0]!.reason, "system:interaction_required");
    assert.equal(calls.aborts[0]!.runId, "run-1");
  });

  it("permission_request → failed（interaction_required）并 abortTurn", async () => {
    const task = makeTask();
    const { gateway, calls } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "permission_request", requestId: "p1", toolName: "read_file", payload: {} } as GatewayEvent,
    ]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "cron_interaction_required");
    assert.match(state.runRecords[0]!.error?.message ?? "", /permission_request/);
    assert.equal(calls.aborts.length, 1);
    assert.equal(calls.aborts[0]!.reason, "system:interaction_required");
  });

  it("stopRequested → stopped", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway(async function* generate() {
      yield { type: "turn_started", runId: "run-1" };
      yield { type: "assistant_text_delta", text: "a" };
      await new Promise(resolve => setTimeout(resolve, 20));
      yield { type: "assistant_text_delta", text: "b" };
    });
    const { store, state } = makeFakeStore(task);
    const activeRuns = new Map<string, CronActiveRun>();
    const { fire } = makeFire({ task, gateway, store, activeRuns });

    const pending = fire.runTask(task, "run-1");
    // registerActiveRun 同步发生，运行中直接置位 stopRequested
    activeRuns.get("run-1")!.stopRequested = true;
    await pending;

    assert.equal(state.runRecords[0]!.outcome, "stopped");
  });

  it("once 任务完成后删除并释放会话，不重算 nextRunAt", async () => {
    const task = makeTask({ schedule: { type: "once", runAt: "2026-08-05T09:00:00.000Z" } });
    const { gateway } = makeFakeGateway([{ type: "turn_started", runId: "run-1" }]);
    const { store, state } = makeFakeStore(task);
    const { fire, releases } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    // 启动认领（revision 0→1）后，once 完成经 updateTask 返回 undefined 删除
    assert.equal(releases.length, 1);
    assert.equal(releases[0]!.taskId, task.taskId);
    assert.ok(state.updateCalls.length >= 2);
    const deleteUpdate = state.updateResults[state.updateResults.length - 1];
    assert.equal(deleteUpdate, undefined);
    // 运行记录仍会写入
    assert.equal(state.runRecords[0]!.outcome, "completed");
  });

  it("cron 任务完成后重算 nextRunAt（schedule v2）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([{ type: "turn_started", runId: "run-1" }]);
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store, now: () => FIXED_NOW });
    await fire.runTask(task, "run-1");
    // 第一次 updateTask 为启动认领（status → running），第二次为完成后重算
    assert.equal(state.updateCalls.length, 2);
    assert.equal(state.updateCalls[1]!.taskId, task.taskId);
    const updated = state.updateResults[1];
    assert.ok(updated);
    assert.equal(updated.status, "scheduled");
    assert.equal(updated.scheduleComputationVersion, 2);
    // */5 * * * * 在 10:00 之后的下一次触发为 10:05
    assert.equal(updated.nextRunAt, "2026-08-05T10:05:00.000Z");
    assert.equal(updated.timezone, "UTC");
  });

  it("任务快照不匹配（已被其他路径修改）→ 认领失败 aborted，不消费 submitTurn、不写任何记录", async () => {
    const task = makeTask();
    const { gateway, calls } = makeFakeGateway([{ type: "turn_started", runId: "run-1" }]);
    const { store, state } = makeFakeStore(task);
    // 模拟任务在调度读取后被编辑（revision 前进），运行时的快照已过期
    await store.updateTask(task.taskId, current => ({ ...current, revision: 99 }));
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(calls.submits.length, 0);
    assert.equal(state.eventCalls.length, 0);
    assert.equal(state.runRecords.length, 0);
    assert.equal(state.deleteCalls.length, 0);
    assert.deepEqual(state.closeCalls, ["run-1"]);
  });

  it("submitTurn 抛出异常 → failed（cron_run_failed）", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway(async function* generate() {
      yield { type: "turn_started", runId: "run-1" };
      throw new Error("gateway exploded");
    });
    const { store, state } = makeFakeStore(task);
    const { fire } = makeFire({ task, gateway, store });
    await fire.runTask(task, "run-1");
    assert.equal(state.runRecords[0]!.outcome, "failed");
    assert.equal(state.runRecords[0]!.error?.code, "cron_run_failed");
    assert.equal(state.runRecords[0]!.error?.message, "gateway exploded");
  });

  it("appendRun 落盘失败经 logger.warn 记录，不阻断投递与任务更新", async () => {
    const task = makeTask();
    const { gateway } = makeFakeGateway([
      { type: "turn_started", runId: "run-1" },
      { type: "assistant_text_delta", text: "ok" },
    ]);
    const { store, state } = makeFakeStore(task, { appendRunError: new Error("disk full") });
    const warns: Array<{ message: string }> = [];
    const deliveries: CronResultDelivery[] = [];
    const { fire } = makeFire({
      task,
      gateway,
      store,
      logger: { warn: message => warns.push({ message }) },
      onResultDelivery: delivery => {
        deliveries.push(delivery);
      },
    });
    await fire.runTask(task, "run-1");
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.message, "cron run terminal record write failed");
    assert.equal(deliveries.length, 1);
    assert.equal(state.updateCalls.length, 2);
    assert.equal(state.closeCalls.length, 1);
  });
});
