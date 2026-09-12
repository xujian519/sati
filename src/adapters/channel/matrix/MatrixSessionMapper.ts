import { ChatSessionMapper, type ChatSessionMapperState } from "../protocol/ChatSessionMapper.js";

export type MatrixSessionMapperState = ChatSessionMapperState;

/** matrix 渠道薄壳：会话键前缀与状态形状由共享实现提供（issue #149）。 */
export class MatrixSessionMapper extends ChatSessionMapper {
  constructor(state?: MatrixSessionMapperState, uuid?: () => string) {
    super("matrix", state, uuid);
  }
}
