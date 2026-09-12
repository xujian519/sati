import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type MattermostSessionMapperState = ChatSessionMapperState;

/** mattermost 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class MattermostSessionMapper extends ChatSessionMapper {
  constructor(state?: MattermostSessionMapperState, uuid?: () => string) {
    super("mattermost", state, uuid);
  }
}
