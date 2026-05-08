import type { IncomingMessage, ServerResponse } from "node:http";
import type { Gateway } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { FeishuSessionMapper } from "./FeishuSessionMapper.js";
import { renderFeishuEvent } from "./feishu-render.js";

export type FeishuOutboundMessage = {
  chatId: string;
  text: string;
};

export type FeishuChannelOptions = {
  mapper?: FeishuSessionMapper;
  send?: (message: FeishuOutboundMessage) => Promise<void>;
};

export class FeishuChannel implements ChannelAdapter {
  readonly channelKey = "feishu";
  private gateway?: Gateway;
  private readonly mapper: FeishuSessionMapper;

  constructor(private readonly options: FeishuChannelOptions = {}) {
    this.mapper = options.mapper ?? new FeishuSessionMapper();
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    return { stop: async () => undefined };
  }

  async handleWebhook(request: IncomingMessage, response: ServerResponse, body: string): Promise<boolean> {
    if (!this.gateway) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "feishu_not_started" }));
      return true;
    }
    const payload = parseFeishuPayload(body);
    if (!payload) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_payload" }));
      return true;
    }
    const mapped = this.mapper.resolve({ chatId: payload.chatId, text: payload.text });
    if (mapped.command === "new" && !mapped.message) {
      await this.send({ chatId: payload.chatId, text: "已创建新会话。" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return true;
    }

    let text = "";
    for await (const event of this.gateway.submitTurn({
      sessionKey: mapped.sessionKey,
      channelKey: "feishu",
      message: mapped.message,
    })) {
      text += renderFeishuEvent(event) ?? "";
    }
    await this.send({ chatId: payload.chatId, text: text.trim() || "完成。" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  private async send(message: FeishuOutboundMessage): Promise<void> {
    await this.options.send?.(message);
  }
}

function parseFeishuPayload(body: string): { chatId: string; text: string } | undefined {
  try {
    const payload = JSON.parse(body) as {
      event?: { message?: { chat_id?: string; content?: string } };
      chatId?: string;
      text?: string;
    };
    if (payload.chatId && payload.text !== undefined) {
      return { chatId: payload.chatId, text: payload.text };
    }
    const chatId = payload.event?.message?.chat_id;
    const content = payload.event?.message?.content;
    if (!chatId || content === undefined) {
      return undefined;
    }
    const parsedContent = JSON.parse(content) as { text?: string };
    return { chatId, text: parsedContent.text ?? "" };
  } catch {
    return undefined;
  }
}
