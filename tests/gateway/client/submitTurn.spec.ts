import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../../src/agent/index.js";
import { InProcessGateway } from "../../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../../src/gateway/SessionRouter.js";

/**
 * submitTurn 核心路径盲区测试（A11 轮 4 收尾）。
 * fake session 用可控信号（hang/release）——gateway 的 finally 会 await pump，
 * 挂起的 session.submit 必须在测试内释放，否则测试挂起被取消。
 */

function createGateway(
  opts: {
    hangOnSubmit?: boolean;
    throwOnSubmit?: boolean;
    afterTurnCompleted?: (input: { sessionKey: string; projectKey?: string; runId: string }) => void;
    recordAgentStatusMessage?: (input: {
      sessionKey: string;
      turnId: string;
      projectKey?: string;
      status: { event?: string };
    }) => Promise<{ recorded: boolean }>;
  } = {},
): { gateway: InProcessGateway; router: SessionRouter; aborted: string[]; release: () => void } {
  const aborted: string[] = [];
  let releaseHang!: () => void;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () =>
      createFakeSession(aborted, opts.hangOnSubmit ?? false, fn => (releaseHang = fn), opts.throwOnSubmit ?? false),
  });
  const gateway = new InProcessGateway(router, {
    uuid: () => "run-1",
    afterTurnCompleted: opts.afterTurnCompleted,
    recordAgentStatusMessage: opts.recordAgentStatusMessage,
  });
  return { gateway, router, aborted, release: () => releaseHang?.() };
}

function createFakeSession(
  aborted: string[],
  hangOnSubmit: boolean,
  setRelease: (fn: () => void) => void,
  throwOnSubmit = false,
): AgentSession {
  return {
    async *submit(_input: AgentInput, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-1";
      yield { type: "turn_started", sessionId: "session-1", turnId };
      if (throwOnSubmit) {
        throw new Error("boom-on-submit");
      }
      if (hangOnSubmit) {
        await new Promise<void>(resolve => {
          setRelease(resolve);
        });
      }
      yield {
        type: "turn_completed",
        sessionId: "session-1",
        turnId,
        result: {
          type: "success",
          sessionId: "session-1",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: "2026-07-20T00:00:00.000Z",
        },
      };
    },
    abort() {
      aborted.push("abort");
    },
    snapshot() {
      return {
        sessionId: "session-1",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}

type DrainedEvent = {
  type: string;
  code?: string;
  event?: string;
  message?: string;
  recoverable?: boolean;
};

async function drain(gateway: InProcessGateway, input: object): Promise<DrainedEvent[]> {
  const events: DrainedEvent[] = [];
  for await (const event of gateway.submitTurn(input as unknown as Parameters<InProcessGateway["submitTurn"]>[0])) {
    events.push(event as DrainedEvent);
  }
  return events;
}

test("submitTurn: 同 session 重复提交返回 session_busy", async () => {
  const { gateway, release } = createGateway({ hangOnSubmit: true });
  const first = gateway.submitTurn({ sessionKey: "s1", channelKey: "web", message: "first" });
  const iterator = first[Symbol.asyncIterator]();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.value.type, "turn_started", "第一个 turn 应启动");

  const secondEvents = await drain(gateway, { sessionKey: "s1", channelKey: "web", message: "second" });
  assert.ok(
    secondEvents.some(e => e.type === "error" && e.code === "session_busy"),
    "重复提交应返回 session_busy",
  );

  release(); // 释放第一个 turn，让 finally 的 await pump 完成
  await iterator.return?.();
});

test("submitTurn: 超时合成 turn_timeout 并 abort session", async () => {
  const { gateway, router, aborted } = createGateway({ hangOnSubmit: true });
  const events = await drain(gateway, {
    sessionKey: "s1",
    channelKey: "web",
    message: "hi",
    timeoutMs: 50,
  });
  assert.ok(
    events.some(e => e.type === "error" && e.code === "turn_timeout"),
    "超时应合成 turn_timeout",
  );
  assert.ok(aborted.length >= 1, "硬超时应调用 session.abort");
  // ctx.timedOut 的唯一可观测后果：超时的会话不可复用，finish 段必须 close 掉它。
  assert.equal(router.cachedSessionCount(), 0, "硬超时后会话必须被 close（不得留在缓存里复用）");
});

test("submitTurn: 正常完成触发 afterTurnCompleted 并清理 emitSinks", async () => {
  const completed: Array<{ sessionKey: string; runId: string }> = [];
  const { gateway, router } = createGateway({
    afterTurnCompleted: input => completed.push(input),
  });
  await drain(gateway, { sessionKey: "s1", channelKey: "web", message: "hi" });
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.sessionKey, "s1");
  assert.equal(completed[0]!.runId, "run-1");
  assert.equal(
    gateway.emitForSession("s1", { type: "agent_status", event: "x", detail: {} }),
    false,
    "turn 结束后 emitSinks 应已清理",
  );
  assert.equal(router.cachedSessionCount(), 1, "正常结束（非超时）不应 evict 缓存会话");
});

test("submitTurn: session.submit 抛错合成 gateway_submit_failed 并落盘 status", async () => {
  const recorded: Array<{ event?: string; text?: string }> = [];
  const { gateway } = createGateway({
    throwOnSubmit: true,
    recordAgentStatusMessage: async input => {
      recorded.push(input.status as { event?: string; text?: string });
      return { recorded: true };
    },
  });
  const events = await drain(gateway, { sessionKey: "s1", channelKey: "web", message: "hi" });
  const statusEvent = events.find(e => e.type === "agent_status");
  assert.ok(statusEvent, "失败应先向流内推 agent_status 事件");
  assert.equal(statusEvent.event, "gateway_submit_failed");
  const failure = events.find(e => e.type === "error");
  assert.ok(failure, "submit 抛错应产出 error 事件");
  assert.equal(failure.code, "gateway_submit_failed");
  assert.equal(failure.recoverable, false);
  assert.match(failure.message ?? "", /boom-on-submit/);
  // 落盘侧与流内事件同源（P2.1 收口到 createSubmitFailedFailure 的那条不变量）。
  assert.equal(recorded.length, 1, "失败 status 应恰好落盘一次");
  assert.equal(recorded[0]!.event, "gateway_submit_failed");
  assert.equal(recorded[0]!.text, failure.message);
  assert.equal(
    gateway.emitForSession("s1", { type: "agent_status", event: "x", detail: {} }),
    false,
    "失败 turn 结束后同样要清 emitSinks",
  );
});
