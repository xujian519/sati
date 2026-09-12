import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type BlueBubblesSessionMapperState = ChatSessionMapperState;

/** bluebubbles 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class BlueBubblesSessionMapper extends ChatSessionMapper {
  constructor(state?: BlueBubblesSessionMapperState, uuid?: () => string) {
    super("bluebubbles", state, uuid);
  }
}
