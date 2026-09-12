import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type SmsSessionMapperState = ChatSessionMapperState;

/** sms 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class SmsSessionMapper extends ChatSessionMapper {
  constructor(state?: SmsSessionMapperState, uuid?: () => string) {
    super("sms", state, uuid);
  }
}
