/**
 * 活跃 turn 绝对投影（协议 1.9，上游 #593 移植）。
 *
 * 本文件是该区域的**首个测试**：`getActiveTurnSnapshot` / `recordActiveTurnEvent` /
 * `activeTurnReplays` 此前在 `tests/` 下零引用。
 *
 * 要钉住的核心不变式：事件日志会被上限截断、且截断从**头部** `shift()`——丢掉的正是
 * 同一段正文的开头（「长回答刷新后从中间开始」这个缺陷的来源），而投影必须完整。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, AgentSession, AgentSubmitOptions } from "../../../src/agent/index.js";
import type { AgentInput } from "../../../src/agent/protocol/input.js";
import { InProcessGateway } from "../../../src/gateway/client/InProcessGateway.js";
import type { GatewayActiveTurnProjectionBlock, GatewayEvent } from "../../../src/gateway/protocol/types.js";
import { SessionRouter } from "../../../src/gateway/SessionRouter.js";

const SESSION_KEY = "web:active-turn-projection";
const TURN_ID = "turn-1";

/** 脚本暂停点：脚本侧 `wait()`，测试侧 `release()`。 */
type PauseStep = { pause: { reached: () => void; wait: () => Promise<void> } };

type Step = { event: AgentEvent } | PauseStep;

type Pause = {
  /** 测试侧：等脚本走到暂停点。 */
  reached: Promise<void>;
  /** 测试侧：放行脚本继续。 */
  release: () => void;
  /** 放进 steps 数组的脚本片段。 */
  step: PauseStep;
};

function createPause(): Pause {
  let markReached: () => void = () => undefined;
  let doRelease: () => void = () => undefined;
  const reached = new Promise<void>(resolve => {
    markReached = resolve;
  });
  const released = new Promise<void>(resolve => {
    doRelease = resolve;
  });
  return {
    reached,
    release: () => doRelease(),
    step: { pause: { reached: () => markReached(), wait: () => released } },
  };
}

function textDelta(text: string): Step {
  return {
    event: { type: "model_event", sessionId: SESSION_KEY, turnId: TURN_ID, event: { type: "text_delta", text } },
  };
}

function thinkingDelta(text: string): Step {
  return {
    event: { type: "model_event", sessionId: SESSION_KEY, turnId: TURN_ID, event: { type: "thinking_delta", text } },
  };
}

function modelRequestStarted(): Step {
  return {
    event: { type: "model_request_started", sessionId: SESSION_KEY, turnId: TURN_ID, model: "fake", provider: "fake" },
  };
}

function createScriptedSession(steps: Step[]): AgentSession {
  return {
    async *submit(_input: AgentInput, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? TURN_ID;
      yield { type: "turn_started", sessionId: SESSION_KEY, turnId };
      for (const step of steps) {
        if ("pause" in step) {
          step.pause.reached();
          await step.pause.wait();
          continue;
        }
        yield step.event;
      }
      yield {
        type: "turn_completed",
        sessionId: SESSION_KEY,
        turnId,
        result: {
          type: "success",
          sessionId: SESSION_KEY,
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-16T00:00:00.000Z",
          completedAt: "2026-09-16T00:00:00.000Z",
        },
      };
    },
    abort() {},
    pendingSteerItems: () => [],
    snapshot() {
      return { sessionId: SESSION_KEY, messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
  } as unknown as AgentSession;
}

function startTurn(steps: Step[]): { gateway: InProcessGateway; done: Promise<GatewayEvent[]> } {
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => createScriptedSession(steps),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const events: GatewayEvent[] = [];
  const done = (async () => {
    for await (const event of gateway.submitTurn({ sessionKey: SESSION_KEY, channelKey: "web", message: "hi" })) {
      events.push(event);
    }
    return events;
  })();
  return { gateway, done };
}

/** 事件日志里仍存活的正文拼接（截断后再拼，会缺开头）。 */
function survivingText(events: GatewayEvent[]): string {
  return events.map(event => (event.type === "assistant_text_delta" ? event.text : "")).join("");
}

function blockShape(blocks: GatewayActiveTurnProjectionBlock[]) {
  return blocks.map(block => ({ kind: block.kind, epoch: block.epoch, text: block.text }));
}

test("短 turn：投影拼接与事件重放拼接一致", async () => {
  const pause = createPause();
  const { gateway, done } = startTurn([textDelta("你好"), textDelta("，世界"), pause.step]);
  await pause.reached;

  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  pause.release();
  await done;

  const blocks = snapshot.projection?.blocks ?? [];
  assert.deepEqual(blockShape(blocks), [{ kind: "text", epoch: 1, text: "你好，世界" }]);
  assert.equal(blocks[0]?.inflight, true);
  assert.equal(survivingText(snapshot.events), "你好，世界");
});

test("超限：事件日志从头部截断，投影仍完整", async () => {
  const deltaCount = 600;
  const steps: Step[] = [];
  for (let index = 0; index < deltaCount; index += 1) {
    steps.push(textDelta(`${index},`));
  }
  const pause = createPause();
  steps.push(pause.step);
  const { gateway, done } = startTurn(steps);
  await pause.reached;

  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  pause.release();
  await done;

  assert.equal(snapshot.truncated, true, "事件数超过 ACTIVE_TURN_EVENT_LIMIT 后必须标记截断");
  const surviving = survivingText(snapshot.events);
  assert.ok(
    surviving.length > 0 && surviving.length < `${deltaCount},`.length * deltaCount,
    "事件日志应已丢掉了正文开头",
  );
  assert.ok(surviving.startsWith("0,") === false, "截断从头部丢：日志开头已不是第一段文本");

  const expected = Array.from({ length: deltaCount }, (_unused, index) => `${index},`).join("");
  const blocks = snapshot.projection?.blocks ?? [];
  assert.deepEqual(blockShape(blocks), [{ kind: "text", epoch: 1, text: expected }], "投影必须完整");
  assert.equal(blocks[0]?.inflight, true);
});

test("通道切换分段：text → thinking → text 得到正文 epoch 1 / 2", async () => {
  const pause = createPause();
  const { gateway, done } = startTurn([textDelta("A"), thinkingDelta("想"), textDelta("B"), pause.step]);
  await pause.reached;

  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  pause.release();
  await done;

  const blocks = snapshot.projection?.blocks ?? [];
  assert.deepEqual(blockShape(blocks), [
    { kind: "text", epoch: 1, text: "A" },
    { kind: "thinking", epoch: 1, text: "想" },
    { kind: "text", epoch: 2, text: "B" },
  ]);
  // 只有仍在增长的当前段带 inflight
  assert.deepEqual(
    blocks.map(block => block.inflight === true),
    [false, false, true],
  );
});

test("model_request_started 使同通道文本另起一段（turn 内多步模型调用）", async () => {
  const pause = createPause();
  const { gateway, done } = startTurn([textDelta("第一步"), modelRequestStarted(), textDelta("第二步"), pause.step]);
  await pause.reached;

  const snapshot = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  pause.release();
  await done;

  const blocks = (snapshot.projection?.blocks ?? []).filter(block => block.kind === "text");
  assert.deepEqual(blockShape(blocks), [
    { kind: "text", epoch: 1, text: "第一步" },
    { kind: "text", epoch: 2, text: "第二步" },
  ]);
});

test("无正文时不带 projection；turn 结束后快照回到 inactive", async () => {
  const pause = createPause();
  const { gateway, done } = startTurn([pause.step]);
  await pause.reached;

  const duringTurn = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  pause.release();
  const events = await done;

  assert.ok(events.some(event => event.type === "turn_started"));
  assert.equal(duringTurn.active, true);
  assert.equal(duringTurn.projection, undefined, "没有正文投影时不应带 projection 字段");

  const afterTurn = await gateway.getActiveTurnSnapshot({ sessionKey: SESSION_KEY });
  assert.equal(afterTurn.active, false);
  assert.equal(afterTurn.projection, undefined);
  assert.deepEqual(afterTurn.events, []);
});
