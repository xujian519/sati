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
 * 渠道侧直接以各自的渠道键构造（`new ChatSessionMapper("slack")`），不再经各渠道薄壳子类：
 * 薄壳只转发 `channelKey` 字面量，无自有成员，删除后渠道的 `mapper` 缝与本类的形状逐字相同
 * （见 `docs/notes/implemented/2026-09-17-adapters-session-mapper-shells.md`；历史见 issue #149）。
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
