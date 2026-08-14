import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CanonicalToolCall } from "../../../src/model/index.js";
import type { SatiToolResult, SatiToolRuntimeContext } from "../../../src/tool/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import { SubagentExecutor } from "../../../src/agent/loop/subagentExecutor.js";

/**
 * SubagentExecutor 行为基线测试（AgentLoop 拆解轮次 3）。
 *
 * 事件泵循环依赖固定 500ms 轮询间隔，挂起场景的用例需要真实等待
 * 一个间隔；快路径（调度器立即 settle）无需等待。
 */

function makeInput(): AgentLoopInput {
  return { sessionId: "/proj::sess-1", turnId: "turn-1", messages: [] };
}

function makeCall(overrides: Partial<CanonicalToolCall> = {}): CanonicalToolCall {
  return { id: "t1", name: "read_file", input: { filePath: "/proj/a.md" }, ...overrides };
}

function resultOf(name: string): SatiToolResult {
  return {
    type: "success",
    toolCallId: `${name}-1`,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:01.000Z",
  };
}

const ctx = {} as SatiToolRuntimeContext;

test("executeToolsWithEventPump：调度器立即完成时返回结果并转发事件", async () => {
  const input = makeInput();
  const events: AgentEvent[] = [];
  const startedEvent: AgentEvent = {
    type: "subagent_started",
    sessionId: "/proj::sess-1",
    turnId: "turn-1",
    subagentId: "sub-1",
    subagentType: "explore",
  };
  const scheduler = { executeAll: async () => [resultOf("read_file")] };
  let drained = false;
  const exec = new SubagentExecutor({
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    scheduler,
    drainEvents: () => {
      // 消费式缓冲：仅首次返回事件（与真实实现一致）。
      if (!drained) {
        drained = true;
        return [startedEvent];
      }
      return [];
    },
  });
  for await (const ev of exec.executeToolsWithEventPump([makeCall()], ctx, input)) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "事件缓冲中的原始事件被转发");
  assert.equal(events[0].type, "subagent_started");
});

test("executeToolsWithEventPump：调度器拒绝时错误传播", async () => {
  const input = makeInput();
  const scheduler = {
    executeAll: async () => {
      throw new Error("boom");
    },
  };
  const exec = new SubagentExecutor({ now: () => new Date(), scheduler });
  await assert.rejects(
    (async () => {
      for await (const _ev of exec.executeToolsWithEventPump([makeCall()], ctx, input)) {
        // 只消费，不关心
      }
    })(),
    /boom/,
  );
});

test("executeToolsWithEventPump：挂起期间子代理工具事件产生 subagent_status", async () => {
  const input = makeInput();
  let resolveExec!: (v: SatiToolResult[]) => void;
  const scheduler = {
    executeAll: () =>
      new Promise<SatiToolResult[]>(resolve => {
        resolveExec = resolve;
      }),
  };
  const nowMs = { t: 1_000_000 };
  const startedEvent: AgentEvent = {
    type: "subagent_started",
    sessionId: "/proj::sess-1",
    turnId: "turn-1",
    subagentId: "sub-1",
    subagentType: "explore",
  };
  const preEvent: AgentEvent = {
    type: "pre_tool_execute",
    sessionId: "/proj::sub::sub-1",
    turnId: "sub-turn",
    toolCallId: "c1",
    toolName: "read_file",
  };
  const postEvent: AgentEvent = {
    type: "post_tool_execute",
    sessionId: "/proj::sub::sub-1",
    turnId: "sub-turn",
    toolCallId: "c1",
    toolName: "read_file",
    success: true,
  };
  let phase = 0;
  const exec = new SubagentExecutor({
    now: () => new Date(nowMs.t),
    scheduler,
    drainEvents: () => {
      // 第一轮泵出启动+工具开始；第二轮泵出工具结束。
      if (phase === 0) {
        phase = 1;
        return [startedEvent, preEvent];
      }
      if (phase === 1) {
        phase = 2;
        resolveExec([resultOf("read_file")]);
        return [postEvent];
      }
      return [];
    },
  });

  const seen: AgentEvent[] = [];
  for await (const ev of exec.executeToolsWithEventPump([makeCall()], ctx, input)) {
    seen.push(ev);
  }

  const statuses = seen.filter(e => e.type === "subagent_status");
  assert.equal(statuses.length, 2, "pre/post 各产生一条状态事件");
  const first = statuses[0] as Extract<AgentEvent, { type: "subagent_status" }>;
  assert.equal(first.status, "tool_started");
  assert.equal(first.subagentId, "sub-1");
  assert.equal(first.toolName, "read_file");
  const second = statuses[1] as Extract<AgentEvent, { type: "subagent_status" }>;
  assert.equal(second.status, "tool_completed");
  assert.equal(second.success, true);
});

test("executeToolsWithEventPump：超过心跳间隔产生 waiting_model 心跳", async () => {
  const input = makeInput();
  let resolveExec!: (v: SatiToolResult[]) => void;
  const scheduler = {
    executeAll: () =>
      new Promise<SatiToolResult[]>(resolve => {
        resolveExec = resolve;
      }),
  };
  let nowMs = 0;
  const startedEvent: AgentEvent = {
    type: "subagent_started",
    sessionId: "/proj::sess-1",
    turnId: "turn-1",
    subagentId: "sub-1",
    subagentType: "explore",
  };
  let drainedOnce = false;
  const exec = new SubagentExecutor({
    now: () => new Date(nowMs),
    scheduler,
    drainEvents: () => {
      if (!drainedOnce) {
        drainedOnce = true;
        return [startedEvent];
      }
      return [];
    },
  });

  const events: AgentEvent[] = [];
  const collecting = (async () => {
    for await (const ev of exec.executeToolsWithEventPump([makeCall()], ctx, input)) {
      events.push(ev);
    }
  })();

  // 第一轮：启动注册（lastHeartbeat=0），间隔未到 → 无心跳。
  await sleep(600);
  assert.equal(events.filter(e => e.type === "subagent_status").length, 0);

  // 推进时钟超过心跳间隔（2s）。
  nowMs = 2_500;

  // 第二轮：心跳产生。
  await sleep(600);
  const heartbeats = events.filter(e => e.type === "subagent_status");
  assert.equal(heartbeats.length, 1);
  const hb = heartbeats[0] as Extract<AgentEvent, { type: "subagent_status" }>;
  assert.equal(hb.status, "waiting_model", "无当前工具时等待模型");
  assert.equal(hb.subagentId, "sub-1");
  assert.equal(hb.durationMs, 2_500);

  // 结束执行。
  resolveExec([]);
  await collecting;
});

test("drainEventBuffer：原始事件直接转发", () => {
  const startedEvent: AgentEvent = {
    type: "subagent_started",
    sessionId: "/proj::sess-1",
    turnId: "turn-1",
    subagentId: "sub-1",
    subagentType: "explore",
  };
  const exec = new SubagentExecutor({
    now: () => new Date(),
    scheduler: { executeAll: async () => [] },
    drainEvents: () => [startedEvent],
  });
  const collected = [...exec.drainEventBuffer()];
  assert.equal(collected.length, 1);
  assert.equal(collected[0].type, "subagent_started");
});
