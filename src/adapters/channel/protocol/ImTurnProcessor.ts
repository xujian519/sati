import type { GatewayChannelKey, GatewayEvent, GatewaySubmitTurnInput } from "../../../gateway/index.js";
import type { ChannelLogger } from "./types.js";

/**
 * 渠道单轮处理循环的共享实现。
 *
 * 各 IM 渠道各自复制同一段「交互捕获 → 渲染事件 → 汇总回复」循环，差异只在渠道
 * 标识、渲染函数与回复目标。本模块收拢该循环，渠道侧只提供闭包化的投递与钩子；
 * 控制流（错误兜底文案、交互状态清理时机）与逐渠道既有实现保持等价。
 */

/** 轮次事件源（`Gateway` 的结构子集）。 */
export interface ChannelTurnGateway {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
}

/** elicitation 捕获面（`ImElicitationHelper` 的结构子集）。 */
export interface ChannelTurnElicitationSink {
  capture(interactionKey: string, sessionKey: string, event: GatewayEvent & { type: "elicitation_request" }): string;
  clear(interactionKey: string): void;
}

/** permission 捕获面（`ImPermissionHelper` 的结构子集）。 */
export interface ChannelTurnPermissionSink {
  capture(
    interactionKey: string,
    sessionKey: string,
    event: GatewayEvent & { type: "permission_request" },
  ): string | undefined;
  clear(interactionKey: string): void;
}

export interface ChannelTurnDeps {
  /** 渠道标识：既是 `submitTurn` 的 `channelKey`，也是错误日志前缀（渠道实现中两者同值）。 */
  channelKey: GatewayChannelKey;
  /** 未连接时整轮跳过（等价渠道侧既有的 `if (!this.gateway) return;` 守卫）。 */
  gateway?: ChannelTurnGateway | undefined;
  elicitation: ChannelTurnElicitationSink;
  permissions: ChannelTurnPermissionSink;
  /** 事件 → 文本片段；返回空表示该事件无用户可见文本。 */
  render: (event: GatewayEvent) => string | null | undefined;
  /** 投递文本。回复目标（chatId / 上下文对象 / 分片参数）由调用方闭包持有。 */
  deliver: (text: string) => Promise<unknown>;
  logger?: ChannelLogger | undefined;
  /** 循环前的 best-effort 动作（如打字指示）。不 await，失败不影响本轮投递。 */
  beforeTurn?: (() => void) | undefined;
  /**
   * 错误日志前缀，默认 `` `${channelKey}: submitTurn error` ``。
   * 同一渠道存在多条循环时（qq 的 c2c 与群聊）用以区分日志来源。
   */
  errorLabel?: string | undefined;
}

export interface ChannelTurnInput {
  /** elicitation/permission 的挂起键。多数渠道等于回复目标，mattermost/qq 不同。 */
  interactionKey: string;
  sessionKey: string;
  message: string;
}

/** 轮次失败时回给用户的兜底文案（各渠道既有文案一致）。 */
export const CHANNEL_TURN_FAILURE_TEXT = "处理消息时发生错误，请重试。";

/**
 * 执行一轮渠道消息：把 `submitTurn` 事件流渲染为回复文本并投递。
 *
 * 交互请求（elicitation/permission）即时投递提问文本并挂起等待用户下一条消息；
 * 其余事件经 `render` 累积，轮次结束时整体 trim 后投递一次。无论成功或失败，
 * 轮末都清理该键上的交互挂起状态。
 */
export async function processChannelTurn(deps: ChannelTurnDeps, input: ChannelTurnInput): Promise<void> {
  const gateway = deps.gateway;
  if (!gateway) return;
  deps.beforeTurn?.();

  let replyText = "";
  try {
    for await (const event of gateway.submitTurn({
      sessionKey: input.sessionKey,
      channelKey: deps.channelKey,
      message: input.message,
    })) {
      if (event.type === "elicitation_request") {
        const questionText = deps.elicitation.capture(input.interactionKey, input.sessionKey, event);
        await deps.deliver(questionText);
        continue;
      }
      if (event.type === "permission_request") {
        const questionText = deps.permissions.capture(input.interactionKey, input.sessionKey, event);
        if (questionText) await deps.deliver(questionText);
        continue;
      }
      const fragment = deps.render(event);
      if (fragment != null) replyText += fragment;
    }
  } catch (e) {
    deps.logger?.error?.(`${deps.errorLabel ?? `${deps.channelKey}: submitTurn error`}: ${e}`);
    replyText = CHANNEL_TURN_FAILURE_TEXT;
  }

  deps.elicitation.clear(input.interactionKey);
  deps.permissions.clear(input.interactionKey);
  const finalText = replyText.trim();
  if (finalText) {
    await deps.deliver(finalText);
  }
}
