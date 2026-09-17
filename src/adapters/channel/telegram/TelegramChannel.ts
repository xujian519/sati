import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import { chunkText } from "../protocol/text.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { dispatchChannelMessage } from "../protocol/ImInboundDispatch.js";
import { processChannelTurn } from "../protocol/ImTurnProcessor.js";
import { ChatSessionMapper } from "../protocol/ChatSessionMapper.js";
import { renderTelegramEvent } from "./telegram-render.js";

// grammy 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface TelegramMessage {
  text?: string;
  chat: { id: number };
}
interface TelegramContext {
  message?: TelegramMessage;
}
interface TelegramBotApi {
  setWebhook(url: string): Promise<unknown>;
  deleteWebhook(): Promise<unknown>;
  getMe(): Promise<{ username?: string }>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
  sendChatAction(chatId: string, action: string): Promise<unknown>;
}
interface TelegramBotLike {
  on(event: string, handler: (ctx: TelegramContext) => Promise<void> | void): void;
  catch(handler: (err: unknown) => void): void;
  api: TelegramBotApi;
  start(options: { drop_pending_updates: boolean }): Promise<unknown> | void;
  stop(): Promise<unknown> | void;
}
type TelegramBotCtor = new (token: string) => TelegramBotLike;

let Bot: TelegramBotCtor | undefined;
try {
  Bot = require("grammy").Bot;
} catch {
  // grammy not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 4096;

export type TelegramChannelOptions = {
  token?: string;
  webhookUrl?: string;
  mapper?: ChatSessionMapper;
};

export class TelegramChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "telegram";

  private readonly mapper: ChatSessionMapper;
  private readonly token?: string;
  private readonly webhookUrl?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private bot: TelegramBotLike | null = null;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: TelegramChannelOptions = {}) {
    this.mapper = options.mapper ?? new ChatSessionMapper("telegram");
    this.token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
    this.webhookUrl = options.webhookUrl;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!Bot) {
      this.logger?.error?.("telegram: grammy not installed; run `npm install grammy`");
      return { stop: async () => undefined };
    }
    if (!this.token) {
      this.logger?.error?.("telegram: TELEGRAM_BOT_TOKEN not set");
      return { stop: async () => undefined };
    }

    try {
      const bot = new Bot(this.token);
      this.bot = bot;
      bot.on("message:text", (ctx: TelegramContext) => this.handleTextMessage(ctx));
      bot.catch((err: unknown) => {
        this.logger?.error?.(`telegram: bot error: ${err}`);
      });

      if (this.webhookUrl) {
        await bot.api.setWebhook(this.webhookUrl);
        this.logger?.info?.(`telegram: webhook mode at ${this.webhookUrl}`);
      } else {
        await bot.api.deleteWebhook();
        // bot.start 启动长轮询并挂起直到 bot 停止：await 会阻塞方法返回，故显式 void（fire-and-forget）。
        void bot.start({ drop_pending_updates: false });
        this.logger?.info?.("telegram: long-polling started");
      }

      const me = await bot.api.getMe();
      this.logger?.info?.(`telegram: connected as @${me.username}`);
    } catch (e) {
      this.logger?.error?.(`telegram: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`telegram: stopping (${reason ?? "no reason"})`);
        if (this.bot) {
          try {
            await this.bot.stop();
          } catch {
            // 停止 bot 失败：引用随即置空，残留由进程退出兜底（fail-safe 清理）。
          }
          this.bot = null;
        }
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendReply(chatId, text));
  }

  private async handleTextMessage(ctx: TelegramContext): Promise<void> {
    const msg = ctx.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);

    await dispatchChannelMessage(
      {
        channelKey: "telegram",
        gateway: this.gateway,
        elicitation: this.elicitation,
        permissions: this.permissions,
        activeChats: this.activeChats,
        mapper: this.mapper,
        send: (id, replyText) => this.sendReply(id, replyText),
        turn: mapped => this.processMessage(chatId, mapped.sessionKey, mapped.message),
        logger: this.logger,
      },
      { interactionKey: chatId, text: msg.text },
    );
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    await processChannelTurn(
      {
        channelKey: "telegram",
        gateway: this.gateway,
        elicitation: this.elicitation,
        permissions: this.permissions,
        render: renderTelegramEvent,
        deliver: text => this.sendReply(chatId, text),
        logger: this.logger,
        beforeTurn: () => {
          void this.sendTyping(chatId);
        },
      },
      { interactionKey: chatId, sessionKey, message },
    );
  }

  private async sendReply(chatId: string, text: string): Promise<boolean> {
    const bot = this.bot;
    if (!bot) return false;
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    let ok = true;
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk);
      } catch (e) {
        this.logger?.error?.(`telegram: sendMessage failed: ${e}`);
        ok = false;
      }
    }
    return ok;
  }

  private async sendTyping(chatId: string): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    try {
      await bot.api.sendChatAction(chatId, "typing");
    } catch {
      // 发送输入中提示失败：仅影响打字指示，不影响后续消息投递（best-effort）。
    }
  }
}
