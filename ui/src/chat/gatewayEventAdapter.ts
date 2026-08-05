/**
 * Gateway 直连聊天（P2b-0）：WebGatewayEvent → 前端聊天消息模型（wire 帧）。
 *
 * 薄封装——映射逻辑在共享模块 `src/web/client/eventMapping.ts`
 * （`@sati/web-client` 的 `mapGatewayEventToFrames`），与
 * `ui/server/sati-bridge.js` / `ui/server/pilotdeck-bridge.js` 的
 * `gatewayEventToFrames` 共用同一份实现，消除双轨漂移。
 *
 * 已知差异（显式）：直连模式不产出 subagent 活动帧（`agent_activity` /
 * `subagent_link`）——server 桥在共享核心之上叠加了带状态的 subagent 扩展层，
 * 直连模式沿用该事件返回空帧（P2b 后续补）。
 */

import type { WebGatewayEvent } from "@sati/web-client";
import { mapGatewayEventToFrames } from "@sati/web-client";

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
  return mapGatewayEventToFrames(event, sessionId, provider) as GatewayEventChatFrame[];
}
