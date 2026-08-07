/**
 * 直连模式 subagent 活动帧（P2b 补齐）。
 *
 * gateway 后端本就发出 `agent_status` 事件（subagent_started/completed/status、
 * subagent_text_delta / subagent_tool_call_started 等，detail 携带
 * subagentId/subagentType）。退役前的 `ui/server/sati-bridge.js` 在共享映射
 * （`@sati/web-client` 的 eventMapping）之上叠加带状态的 subagent 扩展层，
 * 产出 `agent_activity` / `subagent_link` / subagent-detail 帧；直连模式
 * （浏览器 → gateway）此前沿用共享映射返回空帧，导致 reasoning 任务看不到
 * 子代理活动。本模块把该扩展层移植到直连路径。
 *
 * 有状态部分（活动耗时、agent/task 工具调用 → subagent 关联）使用 module 级
 * Map——浏览器单实例，语义与 sati-bridge 扩展层一致。
 */

import type { WebGatewayEvent } from "@sati/web-client";
import { normalizeToolDisplayName } from "@sati/web-client";
import type { GatewayEventChatFrame } from "./gatewayEventAdapter";

const SUBAGENT_STATUS_EVENTS = new Set(["subagent_started", "subagent_completed", "subagent_status"]);
const SUBAGENT_DETAIL_EVENTS = new Set([
  "subagent_text_delta",
  "subagent_thinking_delta",
  "subagent_tool_call_started",
  "subagent_tool_result",
  "subagent_model_error",
]);

/** sessionId → agent/task 工具调用 id 队列（subagent_started 时关联 subagent_link）。 */
const pendingAgentToolCalls = new Map<string, string[]>();
/** `${sessionId}:${subagentId}` → 开始时间（completed/status 时计算耗时）。 */
const subagentActivityStarts = new Map<string, number>();

/** 记录 agent/task 工具调用，供 `subagent_started` 关联 subagent_link。 */
export function trackPendingAgentToolCall(toolCallId: string, toolName: string | undefined, sessionId: string): void {
  const rawName = String(toolName || "").toLowerCase();
  if (rawName !== "agent" && rawName !== "task") return;
  const pending = pendingAgentToolCalls.get(sessionId) || [];
  pending.push(toolCallId);
  pendingAgentToolCalls.set(sessionId, pending);
}

/**
 * 若事件是 subagent 相关，产出 0..n 帧；否则返回 null（调用方回退共享映射）。
 */
export function createSubagentFrames(
  event: Extract<WebGatewayEvent, { type: "agent_status" }>,
  base: { sessionId: string; provider: string; runId?: string },
): GatewayEventChatFrame[] | null {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const subagentId = String(detail.subagentId || "");

  if (SUBAGENT_DETAIL_EVENTS.has(event.event) && subagentId) {
    return createSubagentDetailFrames(event.event, detail, base, subagentId);
  }
  if (!SUBAGENT_STATUS_EVENTS.has(event.event)) return null;

  const id = subagentId || "unknown";
  const status = normalizeSubagentStatus(event.event, detail);
  const subagentType = String(detail.subagentType || "agent");
  const activityKey = `${base.sessionId}:${id}`;
  const nowMs = Date.now();
  const reportedDurationMs = Number(detail.durationMs);
  let startedAtMs = subagentActivityStarts.get(activityKey);
  if (event.event === "subagent_started" || !startedAtMs) {
    startedAtMs = Number.isFinite(reportedDurationMs) && reportedDurationMs > 0 ? nowMs - reportedDurationMs : nowMs;
    subagentActivityStarts.set(activityKey, startedAtMs);
  }
  const durationMs =
    Number.isFinite(reportedDurationMs) && reportedDurationMs >= 0
      ? reportedDurationMs
      : Math.max(0, nowMs - startedAtMs);
  const isDone = status === "completed" || status === "failed";

  const activity: GatewayEventChatFrame = {
    ...base,
    kind: "agent_activity",
    activityId: `subagent:${id}`,
    runId: `subagent:${id}`,
    phase: "subagent",
    state: status,
    title: formatSubagentActivityTitle(subagentType, status),
    detail: formatSubagentActivityDetail(event.event, detail, status),
    subagentId: id,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: isDone ? new Date(nowMs).toISOString() : null,
    durationMs,
    severity: status === "failed" ? "error" : undefined,
    toolName: "agent",
  };
  if (isDone) {
    subagentActivityStarts.delete(activityKey);
  }

  const frames: GatewayEventChatFrame[] = [activity];

  if (event.event === "subagent_started") {
    const link = createSubagentLinkFrame(detail, base, id, subagentType);
    if (link) frames.push(link);
  }
  return frames;
}

function createSubagentLinkFrame(
  detail: Record<string, unknown>,
  base: { sessionId: string; provider: string; runId?: string },
  subagentId: string,
  subagentType: string,
): GatewayEventChatFrame | null {
  let toolCallId = typeof detail.toolCallId === "string" ? detail.toolCallId : "";
  const pending = pendingAgentToolCalls.get(base.sessionId);
  if (!toolCallId) {
    toolCallId = pending?.shift() || "";
    if (pending && pending.length === 0) pendingAgentToolCalls.delete(base.sessionId);
  } else if (pending) {
    const idx = pending.indexOf(toolCallId);
    if (idx !== -1) pending.splice(idx, 1);
    if (pending.length === 0) pendingAgentToolCalls.delete(base.sessionId);
  }
  return {
    ...base,
    kind: "subagent_link",
    subagentId,
    subagentType,
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function createSubagentDetailFrames(
  eventName: string,
  detail: Record<string, unknown>,
  base: { sessionId: string; provider: string; runId?: string },
  subagentId: string,
): GatewayEventChatFrame[] {
  const detailBase: {
    sessionId: string;
    provider?: string;
    runId?: string;
    subagentId: string;
    isSubagentDetail: boolean;
  } = { ...base, subagentId, isSubagentDetail: true };
  switch (eventName) {
    case "subagent_text_delta":
      return [{ ...detailBase, kind: "stream_delta", content: String(detail.text || "") }];
    case "subagent_thinking_delta":
      return [{ ...detailBase, kind: "thinking", content: String(detail.text || "") }];
    case "subagent_tool_call_started": {
      const toolCallId = String(detail.toolCallId || `subagent-${subagentId}-${Date.now()}`);
      return [
        {
          ...detailBase,
          kind: "tool_use",
          toolName: normalizeToolDisplayName(String(detail.toolName || "")),
          toolInput: detail.input || {},
          toolId: toolCallId,
        },
      ];
    }
    case "subagent_tool_result": {
      const toolCallId = String(detail.toolCallId || `subagent-${subagentId}-${Date.now()}`);
      return [
        {
          ...detailBase,
          kind: "tool_result",
          toolId: toolCallId,
          content: String(detail.content || detail.preview || ""),
          isError: detail.ok === false,
          ...(typeof detail.errorCode === "string" ? { errorCode: detail.errorCode } : {}),
        },
      ];
    }
    case "subagent_model_error":
      return [
        {
          ...detailBase,
          kind: "error",
          content: String(detail.message || detail.error || "Subagent model error"),
        },
      ];
    default:
      return [];
  }
}

function normalizeSubagentStatus(eventName: string, detail: Record<string, unknown>): string {
  if (eventName === "subagent_completed") {
    return detail.success === false ? "failed" : "completed";
  }
  return "running";
}

function formatSubagentActivityTitle(subagentType: string, status: string): string {
  if (status === "completed") {
    return `Subagent ${subagentType} completed`;
  }
  if (status === "failed") {
    return `Subagent ${subagentType} failed`;
  }
  return `Subagent ${subagentType} running`;
}

function formatSubagentActivityDetail(eventName: string, detail: Record<string, unknown>, status: string): string {
  const toolName = typeof detail.toolName === "string" ? detail.toolName : "";
  const rawStatus = String(detail.status || "");
  if (status === "failed") {
    return "执行失败";
  }
  if (status === "completed") {
    return "已完成";
  }
  if ((rawStatus === "tool_started" || rawStatus === "running") && toolName) {
    return `正在执行 ${toolName}`;
  }
  if (rawStatus === "tool_completed" && toolName) {
    return `已完成 ${toolName}`;
  }
  if (eventName === "subagent_started" || rawStatus === "waiting_model" || !toolName) {
    return "思考中";
  }
  return `正在执行 ${toolName}`;
}
