import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import { resolveIncomingMessage } from "./ChannelCommandRegistry.js";
import type { ChannelLogger } from "./types.js";

/**
 * 渠道入站消息的分发前置（共享实现）。
 *
 * 各 IM 渠道在进入单轮处理前重复同一段控制流：交互挂起应答 → 会话去重 →
 * `/new` 与命令解析 → 轮次执行（`activeChats` 包围）。本模块收拢该段，
 * 渠道侧只保留各自的消息解析与前置校验，并注入闭包化的投递与轮次回调。
 */

/** 交互挂起面：`ImElicitationHelper` 与 `ImPermissionHelper` 的同形子集。 */
export interface ChannelDispatchInteraction {
  hasPending(interactionKey: string): boolean;
  answer(interactionKey: string, text: string, gateway: Gateway): Promise<string | undefined>;
}

export interface ChannelDispatchDeps<TMapped extends { command?: "new"; message: string }> {
  /** 渠道标识，用于错误/信息日志前缀。 */
  channelKey: GatewayChannelKey;
  /** 未连接时跳过交互应答（等价渠道侧 `hasPending(k) && this.gateway` 的短路）。 */
  gateway?: Gateway | undefined;
  elicitation: ChannelDispatchInteraction;
  permissions: ChannelDispatchInteraction;
  /** 同一会话的在跑标记；本次交互键已在其中时直接丢弃该条消息。 */
  activeChats: Set<string>;
  mapper: { resolve(input: { chatId: string; text: string }): TMapped };
  /**
   * 投递文本（交互确认与 `/new` 回执）。回复目标由调用方闭包持有——
   * 多数渠道即交互键本身，slack/mattermost 为 `{ channelId, threadTs|rootId }` 上下文对象。
   */
  send: (interactionKey: string, text: string) => Promise<unknown>;
  /** 执行本轮（渠道侧薄壳，内部即 `processChannelTurn`）。 */
  turn: (mapped: TMapped) => Promise<void>;
  logger?: ChannelLogger | undefined;
}

export interface ChannelDispatchInput {
  /** 会话键：交互挂起、去重与 `/new` 解析共用同一键。 */
  interactionKey: string;
  text: string;
}

/**
 * 分发一条入站消息：交互应答优先，其次是去重与命令解析，最后才进入轮次。
 *
 * 返回即表示该条消息已被消费（转入下一轮或已被应答/丢弃），调用方无需再处理。
 */
export async function dispatchChannelMessage<TMapped extends { command?: "new"; message: string }>(
  deps: ChannelDispatchDeps<TMapped>,
  input: ChannelDispatchInput,
): Promise<void> {
  const gateway = deps.gateway;
  if (deps.elicitation.hasPending(input.interactionKey) && gateway) {
    try {
      const confirmation = await deps.elicitation.answer(input.interactionKey, input.text, gateway);
      if (confirmation) await deps.send(input.interactionKey, confirmation);
    } catch (e) {
      deps.logger?.error?.(`${deps.channelKey}: elicitation answer error: ${e}`);
    }
    return;
  }

  if (deps.permissions.hasPending(input.interactionKey) && gateway) {
    try {
      const confirmation = await deps.permissions.answer(input.interactionKey, input.text, gateway);
      if (confirmation) await deps.send(input.interactionKey, confirmation);
    } catch (e) {
      deps.logger?.error?.(`${deps.channelKey}: permission answer error: ${e}`);
    }
    return;
  }

  if (deps.activeChats.has(input.interactionKey)) {
    deps.logger?.info?.(`${deps.channelKey}: chat ${input.interactionKey} already active, skipping`);
    return;
  }

  const { mapped, handled } = await resolveIncomingMessage(deps.mapper, input.interactionKey, input.text, deps.send);
  if (handled) return;

  deps.activeChats.add(input.interactionKey);
  try {
    await deps.turn(mapped);
  } finally {
    deps.activeChats.delete(input.interactionKey);
  }
}
