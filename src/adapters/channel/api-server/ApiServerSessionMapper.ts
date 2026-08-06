import { randomUUID } from "node:crypto";
import { newSessionMessage } from "../protocol/text.js";

export type ApiServerSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class ApiServerSessionMapper {
  constructor(
    private readonly state: ApiServerSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    const newMessage = newSessionMessage(trimmed);
    if (newMessage !== null) {
      const sessionKey = `api_server:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: newMessage,
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `api_server:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): ApiServerSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
