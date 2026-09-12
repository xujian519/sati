import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type DingTalkSessionMapperState = ChatSessionMapperState;

/** dingtalk 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class DingTalkSessionMapper extends ChatSessionMapper {
  constructor(state?: DingTalkSessionMapperState, uuid?: () => string) {
    super("dingtalk", state, uuid);
  }
}
