/**
 * 工具执行事件泵（从 AgentLoop.ts 拆出）。
 *
 * 负责并发执行工具调用，并在等待期间持续泵出子代理状态事件：
 * 子代理启动/完成、工具执行中的状态变化与周期心跳。
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { CanonicalToolCall } from "../../model/index.js";
import type { SatiToolResult, SatiToolRuntimeContext, SatiToolScheduler } from "../../tool/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentLoopInput } from "../protocol/input.js";
import { subagentIdFromSessionId } from "./misc.js";

const TOOL_EVENT_PUMP_INTERVAL_MS = 500;
const SUBAGENT_STATUS_HEARTBEAT_MS = 2_000;

type ActiveSubagentStatus = {
  subagentId: string;
  subagentType?: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  currentToolCallId?: string;
  currentToolName?: string;
};

/** SubagentExecutor 宿主依赖（由 AgentLoop 组装注入）。 */
export type SubagentExecutorHost = {
  now: () => Date;
  drainEvents?: () => AgentEvent[];
  scheduler: SatiToolScheduler;
};

export class SubagentExecutor {
  constructor(private readonly host: SubagentExecutorHost) {}

  /** 泵出事件缓冲中的原始事件（不产生子代理状态事件）。 */
  *drainEventBuffer(): Generator<AgentEvent> {
    const events = this.host.drainEvents?.() ?? [];
    for (const event of events) {
      yield event;
    }
  }

  /** 并发执行工具调用；未结束时按固定间隔泵出子代理状态事件。 */
  async *executeToolsWithEventPump(
    toolCalls: CanonicalToolCall[],
    context: SatiToolRuntimeContext,
    input: AgentLoopInput,
  ): AsyncGenerator<AgentEvent, SatiToolResult[], unknown> {
    const activeSubagents = new Map<string, ActiveSubagentStatus>();
    let results: SatiToolResult[] | undefined;
    let error: unknown;
    let settled = false;

    const execution = this.host.scheduler
      .executeAll(toolCalls, context)
      .then(
        value => {
          results = value;
        },
        err => {
          error = err;
        },
      )
      .finally(() => {
        settled = true;
      });

    while (!settled) {
      await Promise.race([execution, sleep(TOOL_EVENT_PUMP_INTERVAL_MS)]);
      yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
      if (!settled) {
        yield* this.emitSubagentHeartbeats(input, activeSubagents);
      }
    }

    yield* this.drainToolEventBufferForSubagentStatus(input, activeSubagents);
    if (error) throw error;
    return results ?? [];
  }

  private *drainToolEventBufferForSubagentStatus(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const events = this.host.drainEvents?.() ?? [];
    for (const event of events) {
      const statusEvent = this.updateSubagentStatusFromEvent(input, activeSubagents, event);
      yield event;
      if (statusEvent) {
        yield statusEvent;
      }
    }
  }

  private updateSubagentStatusFromEvent(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
    event: AgentEvent,
  ): AgentEvent | undefined {
    if (event.type === "subagent_started") {
      const nowMs = this.host.now().getTime();
      activeSubagents.set(event.subagentId, {
        subagentId: event.subagentId,
        subagentType: event.subagentType,
        startedAtMs: nowMs,
        lastHeartbeatMs: nowMs,
      });
      return undefined;
    }

    if (event.type === "subagent_completed") {
      activeSubagents.delete(event.subagentId);
      return undefined;
    }

    if (event.type !== "pre_tool_execute" && event.type !== "post_tool_execute") {
      return undefined;
    }

    const subagentId = subagentIdFromSessionId(event.sessionId);
    if (!subagentId) {
      return undefined;
    }

    const nowMs = this.host.now().getTime();
    const isPreToolExecute = event.type === "pre_tool_execute";
    const state = activeSubagents.get(subagentId) ?? {
      subagentId,
      startedAtMs: nowMs,
      lastHeartbeatMs: nowMs,
    };
    if (isPreToolExecute) {
      state.currentToolCallId = event.toolCallId;
      state.currentToolName = event.toolName;
    } else {
      state.currentToolCallId = undefined;
      state.currentToolName = undefined;
    }
    state.lastHeartbeatMs = nowMs;
    activeSubagents.set(subagentId, state);

    return {
      type: "subagent_status",
      sessionId: input.sessionId,
      turnId: input.turnId,
      subagentId,
      subagentType: state.subagentType,
      status: isPreToolExecute ? "tool_started" : "tool_completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(isPreToolExecute ? {} : { success: event.success }),
      durationMs: Math.max(0, nowMs - state.startedAtMs),
    };
  }

  private *emitSubagentHeartbeats(
    input: AgentLoopInput,
    activeSubagents: Map<string, ActiveSubagentStatus>,
  ): Generator<AgentEvent> {
    const nowMs = this.host.now().getTime();
    for (const state of activeSubagents.values()) {
      if (nowMs - state.lastHeartbeatMs < SUBAGENT_STATUS_HEARTBEAT_MS) {
        continue;
      }
      state.lastHeartbeatMs = nowMs;
      yield {
        type: "subagent_status",
        sessionId: input.sessionId,
        turnId: input.turnId,
        subagentId: state.subagentId,
        subagentType: state.subagentType,
        status: state.currentToolName ? "running" : "waiting_model",
        toolCallId: state.currentToolCallId,
        toolName: state.currentToolName,
        durationMs: Math.max(0, nowMs - state.startedAtMs),
      };
    }
  }
}
