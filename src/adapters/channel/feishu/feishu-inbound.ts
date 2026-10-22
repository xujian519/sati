export type FeishuParsedEvent =
  | {
      kind: "message";
      eventId: string;
      chatId: string;
      text: string;
      messageId?: string;
      messageType?: string;
      content?: string;
    }
  | { kind: "ignore" };

export function parseDirectShape(raw: Record<string, unknown>): FeishuParsedEvent | undefined {
  if (typeof raw.chatId === "string" && typeof raw.text === "string") {
    return {
      kind: "message",
      eventId: typeof raw.eventId === "string" ? raw.eventId : `direct:${raw.chatId}:${Date.now()}`,
      chatId: raw.chatId,
      text: raw.text,
      messageType: "text",
    };
  }
  return undefined;
}

export function parseV2Event(raw: Record<string, unknown>): FeishuParsedEvent | undefined {
  const header = raw.header as { event_id?: string; event_type?: string } | undefined;
  const event = raw.event as
    | { message?: { chat_id?: string; content?: string; message_type?: string; message_id?: string } }
    | undefined;

  if (!header?.event_id || !event?.message) return undefined;
  if (header.event_type !== "im.message.receive_v1") return { kind: "ignore" };
  if (!isSupportedFeishuInboundType(event.message.message_type)) return { kind: "ignore" };

  const chatId = event.message.chat_id;
  const content = event.message.content;
  if (!chatId || content === undefined) return undefined;

  const text = extractFeishuMessageText(event.message.message_type, content);
  return {
    kind: "message",
    eventId: header.event_id,
    chatId,
    text,
    messageId: event.message.message_id,
    messageType: event.message.message_type,
    content,
  };
}

export function parseV1Event(raw: Record<string, unknown>): FeishuParsedEvent | undefined {
  const event = raw.event as
    | { chat_id?: string; text?: string; type?: string; msg_type?: string; uuid?: string }
    | undefined;
  if (!event?.chat_id || event.text === undefined) return undefined;
  const eventId = (raw.uuid as string | undefined) ?? event.uuid ?? `v1:${event.chat_id}:${Date.now()}`;
  return { kind: "message", eventId, chatId: event.chat_id, text: event.text, messageType: "text" };
}

export function isSupportedFeishuInboundType(messageType: string | undefined): boolean {
  return messageType === "text" || messageType === "image" || messageType === "file";
}

export function extractFeishuMessageText(messageType: string | undefined, content: string): string {
  if (messageType !== "text") return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    // 消息内容非合法 JSON：原样返回文本（fail-safe）。
    return content;
  }
}
