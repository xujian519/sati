import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type WhatsAppSessionMapperState = ChatSessionMapperState;

/** whatsapp 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class WhatsAppSessionMapper extends ChatSessionMapper {
  constructor(state?: WhatsAppSessionMapperState, uuid?: () => string) {
    super("whatsapp", state, uuid);
  }
}
