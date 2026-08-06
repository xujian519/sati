import { randomUUID } from "node:crypto";
import { newSessionMessage } from "../protocol/text.js";

export type QQSessionMapperState = {
  activeByChatKey: Record<string, string>;
};

export class QQSessionMapper {
  constructor(
    private readonly state: QQSessionMapperState = { activeByChatKey: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { groupId: string; userId: string; text: string }): {
    sessionKey: string;
    command?: "new";
    message: string;
  } {
    const chatKey = `${input.groupId}:${input.userId}`;
    const trimmed = input.text.trim();

    const newMessage = newSessionMessage(trimmed);
    if (newMessage !== null) {
      const sessionKey = `qq:group=${input.groupId}:user=${input.userId}:s_${this.uuid()}`;
      this.state.activeByChatKey[chatKey] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: newMessage,
      };
    }

    return {
      sessionKey: this.state.activeByChatKey[chatKey] ?? `qq:group=${input.groupId}:user=${input.userId}:general`,
      message: trimmed,
    };
  }

  snapshot(): QQSessionMapperState {
    return { activeByChatKey: { ...this.state.activeByChatKey } };
  }
}
