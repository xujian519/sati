import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type TelegramSessionMapperState = ChatSessionMapperState;

/** telegram 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class TelegramSessionMapper extends ChatSessionMapper {
  constructor(state?: TelegramSessionMapperState, uuid?: () => string) {
    super("telegram", state, uuid);
  }
}
