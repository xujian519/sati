import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { dispatchChannelMessage } from "../protocol/ImInboundDispatch.js";
import { processChannelTurn } from "../protocol/ImTurnProcessor.js";
import { readRequestBody } from "../protocol/httpBody.js";
import { ChatSessionMapper } from "../protocol/ChatSessionMapper.js";
import { CHANNEL_DEFAULT_PORTS } from "../protocol/channel-defaults.js";
import { renderSmsEvent } from "./sms-render.js";

// twilio 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface TwilioClientLike {
  messages: { create(options: Record<string, unknown>): Promise<unknown> };
}
type TwilioFactory = (accountSid: string, authToken: string) => TwilioClientLike;

let twilioFactory: TwilioFactory | undefined;
try {
  twilioFactory = require("twilio");
} catch {
  // twilio not installed — start() will warn
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/sms/incoming";
const MAX_BODY_BYTES = 1_048_576;
const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export type SmsChannelOptions = {
  extra?: Record<string, unknown>;
  mapper?: ChatSessionMapper;
};

export class SmsChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "sms";

  private readonly mapper: ChatSessionMapper;
  private readonly extra: Record<string, unknown>;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: TwilioClientLike | null = null;
  private server: Server | null = null;
  private accountSid = "";
  private authToken = "";
  private fromNumber = "";
  private publicUrl = "";
  private host = DEFAULT_HOST;
  // 显式标 number：字面量表（as const）推不出「可被环境变量/配置改写」的意图
  private port: number = CHANNEL_DEFAULT_PORTS.sms;
  private path = DEFAULT_PATH;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: SmsChannelOptions = {}) {
    this.mapper = options.mapper ?? new ChatSessionMapper("sms");
    this.extra = options.extra ?? {};
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!twilioFactory) {
      this.logger?.error?.("sms: twilio not installed; run `npm install twilio`");
      return { stop: async () => undefined };
    }

    this.accountSid = String(this.extra.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? "");
    this.authToken = String(
      this.extra.authToken ?? this.extra.apiKey ?? process.env.TWILIO_AUTH_TOKEN ?? this.extra.token ?? "",
    );
    this.fromNumber = String(this.extra.phoneNumber ?? process.env.TWILIO_PHONE_NUMBER ?? "");
    this.host = String(this.extra.webhookHost ?? DEFAULT_HOST);
    this.port = Number(this.extra.webhookPort ?? process.env.TWILIO_WEBHOOK_PORT ?? CHANNEL_DEFAULT_PORTS.sms);
    this.path = String(this.extra.webhookPath ?? DEFAULT_PATH);
    this.publicUrl = String(this.extra.publicUrl ?? "");

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      this.logger?.error?.("sms: missing config; need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
      return { stop: async () => undefined };
    }

    try {
      this.client = twilioFactory(this.accountSid, this.authToken);
    } catch (e) {
      this.logger?.error?.(`sms: twilio init failed: ${e}`);
      return { stop: async () => undefined };
    }

    try {
      this.server = createServer((req, res) => {
        void this.handleHttp(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, this.host, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      this.logger?.info?.(
        `sms: Twilio webhook http://${this.host}:${this.port}${this.path}` +
          (this.publicUrl ? ` (configure Twilio URL: ${this.publicUrl.replace(/\/$/, "")}${this.path})` : ""),
      );
    } catch (e) {
      this.logger?.error?.(`sms: HTTP server failed: ${e}`);
      this.server = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`sms: stopping (${reason ?? "no reason"})`);
        if (this.server) {
          await new Promise<void>(resolve => {
            this.server!.close(() => resolve());
          });
          this.server = null;
        }
        this.client = null;
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendReply(chatId, text));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);
    if (url.pathname !== this.path || req.method !== "POST") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (e) {
      res.statusCode = 400;
      res.end(`Bad Request: ${e}`);
      return;
    }

    let params: Record<string, string>;
    try {
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.includes("application/json")) {
        params = JSON.parse(bodyText) as Record<string, string>;
      } else {
        params = Object.fromEntries(new URLSearchParams(bodyText));
      }
    } catch {
      // 请求体既非合法 JSON 也非表单编码：回 400，拒绝该请求（fail-closed）。
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    const sig = String(req.headers["x-twilio-signature"] ?? "");
    const fullUrl = this.publicUrl
      ? `${this.publicUrl.replace(/\/$/, "")}${this.path}`
      : `http://${this.host}:${this.port}${this.path}`;

    if (this.authToken && sig) {
      if (!this.validateTwilioSignature(fullUrl, params, sig)) {
        this.logger?.warn?.("sms: invalid Twilio signature");
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    const body = params.Body ?? "";
    const from = params.From ?? "";

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/xml");
    res.end(TWIML_OK);

    if (!from || !body.trim()) return;

    void this.handleIncoming(from, body).catch(e => this.logger?.error?.(`sms: handleIncoming error: ${e}`));
  }

  private validateTwilioSignature(url: string, params: Record<string, string>, signature: string): boolean {
    const keys = Object.keys(params).sort();
    let data = url;
    for (const k of keys) {
      data += k + params[k];
    }
    const hmac = createHmac("sha1", this.authToken).update(data).digest("base64");
    try {
      const a = Buffer.from(hmac);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      // 签名非合法 base64 或长度不一时 timingSafeEqual 抛错：一律判定校验失败（保守拒绝）。
      return false;
    }
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    await dispatchChannelMessage(
      {
        channelKey: "sms",
        gateway: this.gateway,
        elicitation: this.elicitation,
        permissions: this.permissions,
        activeChats: this.activeChats,
        mapper: this.mapper,
        send: (id, replyText) => this.sendReply(id, replyText),
        turn: mapped => this.processMessage(chatId, mapped.sessionKey, mapped.message),
        logger: this.logger,
      },
      { interactionKey: chatId, text },
    );
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    await processChannelTurn(
      {
        channelKey: "sms",
        gateway: this.gateway,
        elicitation: this.elicitation,
        permissions: this.permissions,
        render: renderSmsEvent,
        deliver: text => this.sendReply(chatId, text),
        logger: this.logger,
      },
      { interactionKey: chatId, sessionKey, message },
    );
  }

  private async sendReply(chatId: string, text: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.messages.create({
        body: text,
        from: this.fromNumber,
        to: chatId,
      });
      return true;
    } catch (e) {
      this.logger?.error?.(`sms: sendMessage failed: ${e}`);
      return false;
    }
  }
}
