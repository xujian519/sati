import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type SignalSessionMapperState = ChatSessionMapperState;

/** signal 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class SignalSessionMapper extends ChatSessionMapper {
  constructor(state?: SignalSessionMapperState, uuid?: () => string) {
    super("signal", state, uuid);
  }
}
