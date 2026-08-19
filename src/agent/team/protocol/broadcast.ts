/**
 * TeamEvent 广播包装：TeamEvent → GatewayEvent team_event 帧。
 * gateway 协议不升版（复用现有 agent_event 广播通道，无新增方法），
 * 载荷经 `event` 字段整包透传，宿主按需解包消费。
 */
import type { GatewayEvent } from "../../../gateway/protocol/types.js";
import type { TeamEvent } from "./events.js";

/** TeamEvent → GatewayEvent team_event 帧（gateway 协议不升版，事件载荷扩展）。 */
export function toGatewayEvent(event: TeamEvent): Extract<GatewayEvent, { type: "team_event" }> {
  return { type: "team_event", teamId: event.teamId, event };
}
