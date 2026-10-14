/**
 * 路由事件审计落盘 + 后台任务完成通知（P2.7 从 `projectRuntimeFactory.ts` 的
 * `createProjectRuntimeResolver` 内嵌闭包搬出，逐 token 未改）。
 *
 * `createRouterEventBus` 的缓冲/批量 flush 语义（M4）：逐事件 appendFileSync 改 250ms 批量
 * 落盘，`unref` 的 timer 不持 event loop，dispose 路径经注册表的公开字段 `routerEventBus`
 * 同步 flush 收尾（`createLocalGateway` 负责）。events.jsonl 仅供人工审计——无程序化消费与
 * 重建路径，故尾部丢失可接受（每处 try/catch 的失败语义即此取舍的显式留痕）。
 *
 * 取数函数 `getGateway` 是有意的（沿用原代码）：重试进度广播与后台任务完成事件都在
 * **事件发生时**才读 gateway（`setGateway` 晚绑定）。
 */

import { appendFileSync, existsSync, mkdirSync as mkdirSyncFs, renameSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { InProcessGateway } from "../gateway/index.js";
import { createPolicyKey, normalizeRetryReason } from "../model/streaming/retryState.js";
import type { RouterEvent, RouterEventBus } from "../router/protocol/events.js";
import type { AgentTranscriptWriter } from "../session/index.js";
import type { BackgroundTaskCompletionEvent } from "../task/runtime/BackgroundTaskRuntime.js";

/** M4：路由事件审计落盘批量 flush 间隔（unref，不持 event loop）。 */
const ROUTER_EVENT_FLUSH_INTERVAL_MS = 250;

export type RouterEventBusDeps = {
  pilotHome: string;
  now: () => Date;
  getGateway: () => InProcessGateway | undefined;
  /** 活跃会话 transcript 写入器：retry_schedule 落盘按 sessionId 查表。 */
  sessionWriters: Map<string, AgentTranscriptWriter>;
};

export function createRouterEventBus(deps: RouterEventBusDeps): RouterEventBus {
  const pilotHome = deps.pilotHome;
  const routerDir = joinPath(pilotHome, "router");
  try {
    mkdirSyncFs(routerDir, { recursive: true });
  } catch {
    // 目录已存在或创建失败：后续事件写盘会再试，此处失败不阻断（best-effort）。
  }
  const eventsPath = joinPath(routerDir, "events.jsonl");
  try {
    const oldPath = joinPath(pilotHome, "router-events.jsonl");
    if (!existsSync(eventsPath) && existsSync(oldPath)) {
      renameSync(oldPath, eventsPath);
    }
  } catch {
    // 迁移失败：沿用旧文件，events.jsonl 仅审计用，失败不影响主流程（best-effort）。
  }
  // M4：逐事件 appendFileSync 改缓冲 + 250ms 批量 flush。events.jsonl 仅供
  // 人工审计（bootstrap-sati-config 注释），无程序化消费/重建路径——尾部
  // 丢失可接受；flush timer unref 不持 event loop，dispose 时同步 flush 收尾。
  const pendingEvents: RouterEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushPendingEvents = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents.splice(0, pendingEvents.length);
    try {
      appendFileSync(eventsPath, batch.map(event => JSON.stringify(event)).join("\n") + "\n");
    } catch {
      // 事件批量落盘失败：丢弃该批，不中断 agent turn，下批 flush 再试（best-effort）。
    }
  };
  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPendingEvents();
    }, ROUTER_EVENT_FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  };
  return {
    emit: (event: RouterEvent) => {
      pendingEvents.push(event);
      scheduleFlush();
      if (event.type === "sati_router_retry_progress") {
        try {
          deps.getGateway()?.broadcastRetryProgress(event);
        } catch {
          // 重试进度广播失败：事件仅审计展示，丢一条不影响重试链路（best-effort）。
        }
        // 跨进程重启续算 T-A：重试调度写入该会话 transcript 权威序列（log-only）。
        // 事件含 sessionId/turnId；无 turnId（子代理上下文）或会话未登记时跳过。
        try {
          if (typeof event.turnId === "string") {
            const writer = deps.sessionWriters.get(event.sessionId);
            if (writer?.recordRetrySchedule) {
              void writer.recordRetrySchedule(event.sessionId, event.turnId, {
                retryId: event.retryId ?? "",
                provider: event.provider,
                model: event.model,
                policyKey: createPolicyKey(),
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                reason: normalizeRetryReason(event.reason),
                scheduledAt: deps.now().toISOString(),
              });
            }
          }
        } catch {
          // 重试调度落盘失败：不中断 agent turn，下轮或续算路径再补（best-effort）。
        }
      }
    },
    flush: flushPendingEvents,
  };
}

/**
 * 后台任务完成时向该任务的会话投一条 `agent_status` 事件。
 *
 * 整形（等价）：原代码读的是属性 `this.gateway`，TS 收窄跨属性读有效；改取数函数后
 * 每次调用都可能返回 undefined，故守卫前提到局部量，同一同步块内只读一次。
 */
export function emitBackgroundTaskCompletion(
  gateway: InProcessGateway | undefined,
  event: BackgroundTaskCompletionEvent,
): void {
  if (!event.sessionId || !gateway) {
    return;
  }
  const outputPreview = event.outputPreview.trimEnd();
  gateway.emitForSession(event.sessionId, {
    type: "agent_status",
    event: "background_task_completed",
    detail: {
      taskId: event.taskId,
      status: event.status,
      exitCode: event.exitCode ?? null,
      totalBytes: event.totalBytes,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      ...(outputPreview ? { outputPreview } : {}),
    },
  });
}
