import { join } from "node:path";
import { chunkText } from "../protocol/text.js";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { MatrixSessionMapper } from "./MatrixSessionMapper.js";
import { renderMatrixEvent } from "./matrix-render.js";

// matrix-bot-sdk 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface MatrixRoomMessage {
  sender?: string;
  content?: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: { rel_type?: string };
    [key: string]: unknown;
  };
}
interface MatrixClientLike {
  getUserId(): Promise<string | null>;
  joinRoom(roomId: string): Promise<unknown>;
  on(event: "room.invite", handler: (roomId: string) => void): void;
  on(event: "room.message", handler: (roomId: string, message: MatrixRoomMessage) => void): void;
  start(): Promise<unknown>;
  stop(): Promise<unknown> | void;
  sendMessage(roomId: string, content: { msgtype: string; body: string }): Promise<unknown>;
}
type MatrixClientCtor = new (homeserver: string, accessToken: string, storage: unknown) => MatrixClientLike;
type SimpleFsStorageProviderCtor = new (path: string) => unknown;

let MatrixSdk: { MatrixClient: MatrixClientCtor; SimpleFsStorageProvider: SimpleFsStorageProviderCtor } | undefined;
try {
  MatrixSdk = require("matrix-bot-sdk");
} catch {
  // matrix-bot-sdk not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 4000;

export type MatrixChannelOptions = {
  accessToken?: string;
  homeserver?: string;
  userId?: string;
  storagePath?: string;
  mapper?: MatrixSessionMapper;
};

export class MatrixChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "matrix";

  private readonly mapper: MatrixSessionMapper;
  private readonly accessToken?: string;
  private readonly homeserver?: string;
  private readonly userIdOption?: string;
  private readonly storagePath: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: MatrixClientLike | null = null;
  private userId: string | null = null;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: MatrixChannelOptions = {}) {
    this.mapper = options.mapper ?? new MatrixSessionMapper();
    this.accessToken = options.accessToken ?? process.env.MATRIX_ACCESS_TOKEN;
    this.homeserver = (options.homeserver ?? process.env.MATRIX_HOMESERVER ?? "").replace(/\/$/, "") || undefined;
    this.userIdOption = options.userId ?? process.env.MATRIX_USER_ID;
    this.storagePath = options.storagePath ?? join(process.cwd(), ".matrix-bot-storage.json");
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!MatrixSdk) {
      this.logger?.error?.("matrix: matrix-bot-sdk not installed; run `npm install matrix-bot-sdk`");
      return { stop: async () => undefined };
    }
    if (!this.homeserver) {
      this.logger?.error?.("matrix: homeserver not set (MATRIX_HOMESERVER)");
      return { stop: async () => undefined };
    }
    if (!this.accessToken) {
      this.logger?.error?.("matrix: access token not set (MATRIX_ACCESS_TOKEN)");
      return { stop: async () => undefined };
    }

    const { MatrixClient, SimpleFsStorageProvider } = MatrixSdk;

    try {
      const storage = new SimpleFsStorageProvider(this.storagePath);
      this.client = new MatrixClient(this.homeserver, this.accessToken, storage);

      try {
        this.userId = (await this.client.getUserId()) ?? this.userIdOption ?? null;
      } catch {
        // getUserId 失败：回退到 option 配置或 null，不阻塞启动（fail-safe）。
        this.userId = this.userIdOption ?? null;
      }

      this.client.on("room.invite", (roomId: string) => {
        const client = this.client;
        if (!client) return;
        void client.joinRoom(roomId).catch((e: unknown) => {
          this.logger?.warn?.(`matrix: joinRoom failed: ${e}`);
        });
      });

      this.client.on("room.message", (roomId: string, raw: MatrixRoomMessage) => {
        void this.handleRoomMessage(roomId, raw).catch(e => {
          this.logger?.error?.(`matrix: room.message error: ${e}`);
        });
      });

      await this.client.start();
      this.logger?.info?.(`matrix: syncing as ${this.userId ?? "(unknown user)"}`);
    } catch (e) {
      this.logger?.error?.(`matrix: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`matrix: stopping (${reason ?? "no reason"})`);
        if (this.client) {
          try {
            await this.client.stop();
          } catch {
            // 停止时连接清理失败：引用随即置空，残留由 GC/系统回收（fail-safe）。
          }
          this.client = null;
        }
        this.userId = null;
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendReply(chatId, text));
  }

  private async handleRoomMessage(roomId: string, raw: MatrixRoomMessage): Promise<void> {
    const sender = raw?.sender;
    if (!sender) return;
    if (this.userId && sender === this.userId) return;

    const content = raw.content ?? {};
    const relates = content["m.relates_to"] ?? {};
    if (relates["rel_type"] === "m.replace") return;

    const msgtype = content.msgtype || "m.text";
    if (msgtype !== "m.text") return;
    if (content.msgtype === "m.notice") return;

    const text = String(content.body ?? "").trim();
    if (!text) return;

    if (this.elicitation.hasPending(roomId) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(roomId, text, this.gateway);
        if (confirmation) await this.sendReply(roomId, confirmation);
      } catch (e) {
        this.logger?.error?.(`matrix: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(roomId) && this.gateway) {
      try {
        const confirmation = await this.permissions.answer(roomId, text, this.gateway);
        if (confirmation) await this.sendReply(roomId, confirmation);
      } catch (e) {
        this.logger?.error?.(`matrix: permission answer error: ${e}`);
      }
      return;
    }

    if (this.activeChats.has(roomId)) {
      this.logger?.info?.(`matrix: room ${roomId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: roomId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(roomId, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(roomId);
    try {
      await this.processMessage(roomId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(roomId);
    }
  }

  private async processMessage(roomId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "matrix",
        message,
      })) {
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(roomId, sessionKey, event);
          await this.sendReply(roomId, questionText);
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(roomId, sessionKey, event);
          if (questionText) await this.sendReply(roomId, questionText);
          continue;
        }
        const fragment = renderMatrixEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`matrix: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    this.elicitation.clear(roomId);
    this.permissions.clear(roomId);

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(roomId, finalText);
    }
  }

  private async sendReply(roomId: string, text: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    let ok = true;
    for (const chunk of chunks) {
      try {
        await client.sendMessage(roomId, {
          msgtype: "m.text",
          body: chunk,
        });
      } catch (e) {
        this.logger?.error?.(`matrix: sendMessage failed: ${e}`);
        ok = false;
      }
    }
    return ok;
  }
}
