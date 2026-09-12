import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type HomeAssistantSessionMapperState = ChatSessionMapperState;

/** homeassistant 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class HomeAssistantSessionMapper extends ChatSessionMapper {
  constructor(state?: HomeAssistantSessionMapperState, uuid?: () => string) {
    super("homeassistant", state, uuid);
  }
}
