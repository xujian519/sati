import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type DiscordSessionMapperState = ChatSessionMapperState;

/** discord 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class DiscordSessionMapper extends ChatSessionMapper {
  constructor(state?: DiscordSessionMapperState, uuid?: () => string) {
    super("discord", state, uuid);
  }
}
