import { randomUUID } from "node:crypto";
import { newSessionMessage } from "./text.js";

/** 各渠道共用的「按 chatId 维护活跃会话」映射器状态。 */
export type ChatSessionMapperState = {
  activeByChatId: Record<string, string>;
};

/**
 * 通用 ChatSessionMapper：会话键形如 `<channelKey>:chat=<chatId>:s_<uuid>`，
 * 支持 `/new` 指令开新会话，并提供活跃映射快照。
 *
 * 渠道侧以固定 `channelKey` 的薄壳子类复用（保留各渠道既有类名与 State 类型导出面），
 * 取代 13 份逐字相同的实现（见 `docs/techdebt/adapters-shared-mapper.md` 与 issue #149）。
 */
export class ChatSessionMapper {
  constructor(
    private readonly channelKey: string,
    private readonly state: ChatSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    const newMessage = newSessionMessage(trimmed);
    if (newMessage !== null) {
      const sessionKey = `${this.channelKey}:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: newMessage,
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `${this.channelKey}:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): ChatSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
