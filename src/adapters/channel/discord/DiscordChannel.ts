import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import { chunkText } from "../protocol/text.js";
import { resolveIncomingMessage } from "../protocol/ChannelCommandRegistry.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { DiscordSessionMapper } from "./DiscordSessionMapper.js";
import { renderDiscordEvent } from "./discord-render.js";

// discord.js 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface DiscordUserLike {
  id: string;
  bot?: boolean;
  tag?: string;
}
interface DiscordMessageLike {
  author?: DiscordUserLike;
  system?: boolean;
  content?: string;
  channel?: { id?: string };
}
interface DiscordChannelLike {
  send(args: { content: string }): Promise<unknown>;
  sendTyping(): Promise<unknown>;
}
interface DiscordClientLike {
  on(event: "ready", handler: (client: DiscordClientLike) => void): void;
  on(event: "messageCreate", handler: (message: DiscordMessageLike) => void): void;
  on(event: string, handler: (err: unknown) => void): void;
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown> | void;
  channels: { fetch(id: string): Promise<unknown> };
  user?: DiscordUserLike;
}
type DiscordClientCtor = new (options: { intents: unknown[]; partials: unknown[] }) => DiscordClientLike;

let DiscordLib:
  | { Client: DiscordClientCtor; GatewayIntentBits: Record<string, unknown>; Partials: Record<string, unknown> }
  | undefined;
try {
  DiscordLib = require("discord.js");
} catch {
  // discord.js not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 2000;

export type DiscordChannelOptions = {
  token?: string;
  mapper?: DiscordSessionMapper;
};

export class DiscordChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "discord";

  private readonly mapper: DiscordSessionMapper;
  private readonly token?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: DiscordClientLike | null = null;
  private botUserId: string | null = null;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: DiscordChannelOptions = {}) {
    this.mapper = options.mapper ?? new DiscordSessionMapper();
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!DiscordLib) {
      this.logger?.error?.("discord: discord.js not installed; run `npm install discord.js`");
      return { stop: async () => undefined };
    }
    if (!this.token) {
      this.logger?.error?.("discord: DISCORD_BOT_TOKEN not set");
      return { stop: async () => undefined };
    }

    const { Client, GatewayIntentBits, Partials } = DiscordLib;

    try {
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });
      this.client = client;

      client.on("ready", (c: DiscordClientLike) => {
        this.botUserId = c.user?.id ?? null;
        this.logger?.info?.(`discord: logged in as ${c.user?.tag ?? this.botUserId}`);
      });

      client.on("messageCreate", (message: DiscordMessageLike) => {
        void this.handleMessageCreate(message).catch(e => {
          this.logger?.error?.(`discord: messageCreate error: ${e}`);
        });
      });

      client.on("error", (err: unknown) => {
        this.logger?.error?.(`discord: client error: ${err}`);
      });

      await client.login(this.token);
    } catch (e) {
      this.logger?.error?.(`discord: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`discord: stopping (${reason ?? "no reason"})`);
        if (this.client) {
          try {
            await this.client.destroy();
          } catch {
            /* best effort */
          }
          this.client = null;
        }
        this.botUserId = null;
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendReply(chatId, text));
  }

  private async handleMessageCreate(message: DiscordMessageLike): Promise<void> {
    if (!message?.author || message.author.bot) return;
    if (message.system) return;
    if (this.botUserId && message.author.id === this.botUserId) return;

    const text = String(message.content ?? "").trim();
    if (!text) return;

    const chatId = String(message.channel?.id ?? "");
    if (!chatId) return;

    if (this.elicitation.hasPending(chatId) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(chatId, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation);
      } catch (e) {
        this.logger?.error?.(`discord: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(chatId) && this.gateway) {
      try {
        const confirmation = await this.permissions.answer(chatId, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation);
      } catch (e) {
        this.logger?.error?.(`discord: permission answer error: ${e}`);
      }
      return;
    }

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`discord: chat ${chatId} already active, skipping`);
      return;
    }

    const { mapped, handled } = await resolveIncomingMessage(this.mapper, chatId, text, (id, t) =>
      this.sendReply(id, t),
    );
    if (handled) return;

    this.activeChats.add(chatId);
    try {
      await this.processMessage(chatId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    void this.sendTyping(chatId);

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "discord",
        message,
      })) {
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(chatId, sessionKey, event);
          await this.sendReply(chatId, questionText);
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(chatId, sessionKey, event);
          if (questionText) await this.sendReply(chatId, questionText);
          continue;
        }
        const fragment = renderDiscordEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`discord: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    this.elicitation.clear(chatId);
    this.permissions.clear(chatId);
    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    let channel: unknown;
    try {
      channel = await client.channels.fetch(chatId);
    } catch (e) {
      this.logger?.error?.(`discord: fetch channel failed: ${e}`);
      return false;
    }
    if (!isDiscordChannelLike(channel)) {
      this.logger?.warn?.(`discord: channel ${chatId} not sendable`);
      return false;
    }
    const sendable = channel;
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    let ok = true;
    for (const chunk of chunks) {
      try {
        await sendable.send({ content: chunk });
      } catch (e) {
        this.logger?.error?.(`discord: send failed: ${e}`);
        ok = false;
      }
    }
    return ok;
  }

  private async sendTyping(chatId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const channel = await client.channels.fetch(chatId);
      if (isDiscordChannelLike(channel) && typeof channel.sendTyping === "function") {
        await channel.sendTyping();
      }
    } catch {
      /* best effort */
    }
  }
}

/** 从 channels.fetch 的返回值窄化出可发送的频道对象。 */
function isDiscordChannelLike(value: unknown): value is DiscordChannelLike {
  return typeof value === "object" && value !== null && typeof (value as DiscordChannelLike).send === "function";
}
