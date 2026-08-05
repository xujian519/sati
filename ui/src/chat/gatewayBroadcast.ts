/**
 * P2b-4：多标签页实时镜像——BroadcastChannel 封装（可测）。
 *
 * 直连模式下每个标签页独立连接 gateway；发起 turn 的标签页把归一化后的
 * 消息帧经 BroadcastChannel 广播，其他标签页合并展示（实时加速）。
 *
 * 正确性**不依赖**广播：任何标签页可独立经 transcript 重载 / snapshot 恢复
 * （草案 §3 方案 A 主 + C 辅）。
 *
 * 语义说明：BroadcastChannel 不会向发送方自身回传消息，因此无需 source 去重；
 * 接收方按 frame.sessionId 自行路由（与现网 ws 推送语义一致）。
 */

export const CHAT_BROADCAST_CHANNEL = "sati-chat";

export type ChatBroadcastEnvelope = {
  source: "gateway_direct";
  sessionId: string;
  frame: unknown;
};

type BroadcastChannelLike = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: { data?: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data?: unknown }) => void) => void;
  close: () => void;
};

function isBroadcastEnvelope(data: unknown): data is ChatBroadcastEnvelope {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as ChatBroadcastEnvelope).source === "gateway_direct" &&
    typeof (data as ChatBroadcastEnvelope).sessionId === "string"
  );
}

export type ChatBroadcast = {
  /** 广播一帧消息给其他标签页。 */
  post: (sessionId: string, frame: unknown) => void;
  /** 订阅其他标签页广播的帧。返回取消函数。 */
  subscribe: (handler: (envelope: ChatBroadcastEnvelope) => void) => () => void;
  close: () => void;
};

export function createChatBroadcast(): ChatBroadcast {
  const channel: BroadcastChannelLike | null =
    typeof BroadcastChannel !== "undefined"
      ? (new BroadcastChannel(CHAT_BROADCAST_CHANNEL) as BroadcastChannelLike)
      : null;

  return {
    post(sessionId: string, frame: unknown) {
      channel?.postMessage({ source: "gateway_direct", sessionId, frame } satisfies ChatBroadcastEnvelope);
    },
    subscribe(handler: (envelope: ChatBroadcastEnvelope) => void): () => void {
      if (!channel) return () => {};
      const listener = (event: { data?: unknown }) => {
        if (!isBroadcastEnvelope(event.data)) return;
        handler(event.data);
      };
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
    close() {
      channel?.close();
    },
  };
}
