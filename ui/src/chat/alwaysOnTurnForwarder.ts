/**
 * Always-On turn 事件 → 聊天 wire 帧转发器。
 *
 * P3 直连模式下，gateway 对全部 ws 连接广播 `always-on:turn-event`
 * notification 帧（无 request id）。本模块负责：
 *   1. 载荷校验（类型守卫，替代 ad-hoc cast）；
 *   2. 会话生命周期：首次见到某 sessionKey 补发 `session_created`
 *      （knownSessions 语义，原 sati-bridge 转发器的等价实现），
 *      `turn_completed` 后清除以便下一轮重新补发；
 *   3. 事件经 `gatewayEventToChatFrames` 归一化后逐帧广播。
 *
 * 状态与 handler 同生命周期：调用方在挂载时 `new` 一个实例并注册
 * notification handler，卸载时注销——无需模块级去重状态。
 */

import type { WebGatewayEvent } from "@sati/web-client";
import { gatewayEventToChatFrames, type GatewayEventChatFrame } from "./gatewayEventAdapter";

export type AlwaysOnTurnPayload = {
  sessionKey: string;
  event: WebGatewayEvent;
};

export const ALWAYS_ON_TURN_NOTIFICATION = "always-on:turn-event";

export function isAlwaysOnTurnNotification(name: string): name is typeof ALWAYS_ON_TURN_NOTIFICATION {
  return name === ALWAYS_ON_TURN_NOTIFICATION;
}

/** 校验 notification 载荷形状；不满足返回 null（调用方应静默忽略）。 */
export function parseAlwaysOnTurnPayload(payload: unknown): AlwaysOnTurnPayload | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const { sessionKey, event } = payload as Record<string, unknown>;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return null;
  }
  if (typeof event !== "object" || event === null) {
    return null;
  }
  return { sessionKey, event: event as WebGatewayEvent };
}

export type AlwaysOnTurnBroadcast = (frame: unknown) => void;

/**
 * 会话级转发状态机。`handle` 幂等：重复的同会话事件不重复补发
 * `session_created`，直到 `turn_completed` 重置该会话。
 */
export class AlwaysOnTurnForwarder {
  private readonly knownSessions = new Set<string>();

  constructor(private readonly broadcast: AlwaysOnTurnBroadcast) {}

  handleNotification(name: string, payload: unknown): void {
    if (!isAlwaysOnTurnNotification(name)) {
      return;
    }
    const parsed = parseAlwaysOnTurnPayload(payload);
    if (!parsed) {
      return;
    }
    const { sessionKey, event } = parsed;

    if (!this.knownSessions.has(sessionKey)) {
      this.knownSessions.add(sessionKey);
      this.broadcast({ kind: "session_created", newSessionId: sessionKey, sessionKey, provider: "sati" });
    }

    for (const frame of this.toChatFrames(event, sessionKey)) {
      this.broadcast(frame);
    }

    if (event.type === "turn_completed") {
      this.knownSessions.delete(sessionKey);
    }
  }

  private toChatFrames(event: WebGatewayEvent, sessionKey: string): GatewayEventChatFrame[] {
    return gatewayEventToChatFrames(event, sessionKey);
  }
}
