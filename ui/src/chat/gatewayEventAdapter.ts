/**
 * Gateway 直连聊天（P2b-0）：WebGatewayEvent → 前端聊天消息模型（wire 帧）。
 *
 * 薄封装——映射逻辑在共享模块 `src/web/client/eventMapping.ts`
 * （`@sati/web-client` 的 `mapGatewayEventToFrames`），与
 * `ui/server/sati-bridge.js` / `ui/server/pilotdeck-bridge.js` 的
 * `gatewayEventToFrames` 共用同一份实现，消除双轨漂移。
 *
 * 直连模式在共享核心之上叠加带状态的 subagent 扩展层（`subagentFrames.ts`）：
 * gateway 的 `agent_status`（subagent_started/completed/status、subagent_text_delta
 * 等）→ `agent_activity` / `subagent_link` / subagent-detail 帧，与退役
 * sati-bridge 扩展层语义一致（P2b 补齐）。
 */

import type { WebGatewayEvent } from "@sati/web-client";
import { mapGatewayEventToFrames } from "@sati/web-client";
import { createSubagentFrames, trackPendingAgentToolCall } from "./subagentFrames";

/** wire 帧：与 ui/server `createNormalizedMessage` 输出同构（无 id/timestamp envelope）。 */
export type GatewayEventChatFrame = {
  kind: string;
  sessionId: string;
  provider?: string;
  runId?: string;
  [key: string]: unknown;
};

/**
 * 将单个 gateway 事件转换为 0..n 条 wire 帧。
 * 返回空数组表示该事件对 UI 不可见（如普通 agent_status 进度）。
 */
export function gatewayEventToChatFrames(
  event: WebGatewayEvent,
  sessionId: string,
  provider = "sati",
): GatewayEventChatFrame[] {
  const base: { sessionId: string; provider: string; runId?: string } = {
    sessionId,
    provider,
    ...(event.runId ? { runId: event.runId } : {}),
  };

  // subagent 活动帧：直连模式扩展层（agent_status 的 subagent_* 事件）。
  if (event.type === "agent_status") {
    const subagentFrames = createSubagentFrames(event, base);
    if (subagentFrames && subagentFrames.length > 0) return subagentFrames;
  }
  // 记录 agent/task 工具调用，供 subagent_started 关联 subagent_link。
  if (event.type === "tool_call_started") {
    trackPendingAgentToolCall(event.toolCallId, event.name, sessionId);
  }

  return mapGatewayEventToFrames(event, sessionId, provider) as GatewayEventChatFrame[];
}
