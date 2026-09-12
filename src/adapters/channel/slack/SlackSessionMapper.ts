import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type SlackSessionMapperState = ChatSessionMapperState;

/** slack 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class SlackSessionMapper extends ChatSessionMapper {
  constructor(state?: SlackSessionMapperState, uuid?: () => string) {
    super("slack", state, uuid);
  }
}
