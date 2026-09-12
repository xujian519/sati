import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type WebhookSessionMapperState = ChatSessionMapperState;

/** webhook 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class WebhookSessionMapper extends ChatSessionMapper {
  constructor(state?: WebhookSessionMapperState, uuid?: () => string) {
    super("webhook", state, uuid);
  }
}
