import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type EmailSessionMapperState = ChatSessionMapperState;

/** email 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class EmailSessionMapper extends ChatSessionMapper {
  constructor(state?: EmailSessionMapperState, uuid?: () => string) {
    super("email", state, uuid);
  }
}
