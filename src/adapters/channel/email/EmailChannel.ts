import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { dispatchChannelMessage } from "../protocol/ImInboundDispatch.js";
import { processChannelTurn } from "../protocol/ImTurnProcessor.js";
import { EmailSessionMapper } from "./EmailSessionMapper.js";
import { renderEmailEvent } from "./email-render.js";

// imapflow / nodemailer 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface ImapMessageLike {
  uid: number;
  envelope?: { from?: Array<{ address?: string }> };
  source?: Buffer | string;
}
interface ImapMailboxLock {
  release(): void;
}
interface ImapClientLike {
  connect(): Promise<unknown>;
  mailboxOpen(mailbox: string): Promise<unknown>;
  status(mailbox: string, query: Record<string, boolean>): Promise<{ uidNext?: number }>;
  fetch(range: string | Record<string, boolean>, options: Record<string, boolean>): AsyncIterable<ImapMessageLike>;
  getMailboxLock(mailbox: string): Promise<ImapMailboxLock>;
  logout(): Promise<unknown>;
}
type ImapFlowCtor = new (config: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: boolean;
}) => ImapClientLike;
interface MailTransporterLike {
  verify(): Promise<unknown>;
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}
type CreateTransportFn = (config: {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
}) => MailTransporterLike;

let ImapFlow: ImapFlowCtor | undefined;
let nodemailer: { createTransport: CreateTransportFn } | undefined;
try {
  ImapFlow = require("imapflow").ImapFlow;
} catch {
  // imapflow not installed — start() will warn
}
try {
  nodemailer = require("nodemailer");
} catch {
  // nodemailer not installed — start() will warn
}

const DEFAULT_POLL_INTERVAL_MS = 45_000;

export type EmailChannelOptions = {
  extra?: Record<string, unknown>;
  mapper?: EmailSessionMapper;
};

export class EmailChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "email";

  private readonly mapper: EmailSessionMapper;
  private readonly extra: Record<string, unknown>;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private imapClient: ImapClientLike | null = null;
  private transporter: MailTransporterLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenUids = new Set<number>();
  private ownAddress = "";
  private defaultSubject = "Message";
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();
  private stopped = false;

  constructor(options: EmailChannelOptions = {}) {
    this.mapper = options.mapper ?? new EmailSessionMapper();
    this.extra = options.extra ?? {};
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.stopped = false;

    if (!ImapFlow || !nodemailer) {
      this.logger?.error?.("email: imapflow and/or nodemailer not installed; run `npm install imapflow nodemailer`");
      return { stop: async () => undefined };
    }

    this.ownAddress = String(this.extra.address ?? process.env.EMAIL_ADDRESS ?? "");
    const password = String(this.extra.password ?? process.env.EMAIL_PASSWORD ?? "");
    const imapHost = String(this.extra.imapHost ?? process.env.IMAP_HOST ?? "");
    const smtpHost = String(this.extra.smtpHost ?? process.env.SMTP_HOST ?? "");
    const imapPort = Number(this.extra.imapPort ?? process.env.IMAP_PORT ?? 993);
    const smtpPort = Number(this.extra.smtpPort ?? process.env.SMTP_PORT ?? 587);
    const pollIntervalMs = Number(this.extra.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const imapTls = this.extra.imapTls !== false;
    const smtpTls = this.extra.smtpTls !== false;
    this.defaultSubject = String(this.extra.defaultSubject ?? "Message");

    if (!this.ownAddress || !password || !imapHost || !smtpHost) {
      this.logger?.error?.(
        "email: missing config; need extra.address, password, imapHost, smtpHost (or env equivalents)",
      );
      return { stop: async () => undefined };
    }

    try {
      const imap = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapTls,
        auth: { user: this.ownAddress, pass: password },
        logger: false,
      });
      this.imapClient = imap;

      await imap.connect();
      await imap.mailboxOpen("INBOX");

      try {
        const st = await imap.status("INBOX", { uidNext: true });
        const next = st.uidNext ?? 1;
        if (next > 1) {
          const from = Math.max(1, next - 300);
          for await (const msg of imap.fetch(`${from}:${next - 1}`, { uid: true })) {
            this.seenUids.add(msg.uid);
          }
        }
      } catch (e) {
        this.logger?.warn?.(`email: UID priming skipped: ${e}`);
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        requireTLS: smtpTls && smtpPort !== 465,
        auth: { user: this.ownAddress, pass: password },
      });
      this.transporter = transporter;
      await transporter.verify();

      await this.pollOnce();
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, pollIntervalMs);

      this.logger?.info?.(`email: IMAP+SMTP connected (${imapHost} / ${smtpHost})`);
    } catch (e) {
      this.logger?.error?.(`email: connect failed: ${e}`);
      await this.cleanupImap();
      this.transporter = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`email: stopping (${reason ?? "no reason"})`);
        this.stopped = true;
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.transporter = null;
        await this.cleanupImap();
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendReply(chatId, text));
  }

  private async cleanupImap(): Promise<void> {
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {
        // 停止时 IMAP 登出失败：引用随即置空，连接由服务端超时回收（fail-safe）。
      }
      this.imapClient = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const imap = this.imapClient;
    if (!imap || this.stopped) return;
    let lock: ImapMailboxLock | undefined;
    try {
      lock = await imap.getMailboxLock("INBOX");
    } catch (e) {
      this.logger?.error?.(`email: failed to acquire mailbox lock: ${e}`);
      return;
    }
    try {
      for await (const msg of imap.fetch({ unseen: true }, { envelope: true, source: true, uid: true })) {
        const uid = msg.uid;
        if (this.seenUids.has(uid)) continue;
        this.seenUids.add(uid);

        const env = msg.envelope;
        const from = env?.from;
        const replyAddr = from?.[0]?.address ?? "unknown";

        let text = "";
        try {
          const raw = msg.source instanceof Buffer ? msg.source.toString("utf8") : String(msg.source ?? "");
          text = this.extractPlainText(raw);
        } catch {
          // 邮件正文解码失败：占位文本占位并向用户说明，不阻塞整轮 poll（fail-safe）。
          text = "[Could not decode message body]";
        }

        if (!text.trim()) continue;

        void this.handleIncoming(replyAddr, text);
      }
    } catch (e) {
      this.logger?.error?.(`email: poll error: ${e}`);
    } finally {
      try {
        lock?.release?.();
      } catch {
        // 释放锁失败：锁由进程退出兜底释放，不阻断 poll 收尾（best-effort）。
      }
    }
  }

  private extractPlainText(raw: string): string {
    if (!raw.includes("Content-Type:")) {
      return raw.trim();
    }
    const plain = raw.match(/Content-Type:\s*text\/plain[^\r\n]*[\r\n]+([\s\S]*?)(?=--[a-f0-9]{8,}|Content-Type:|$)/i);
    if (plain?.[1]) {
      let body = plain[1].replace(/^\r?\n/, "");
      const te = body.match(/^Content-Transfer-Encoding:\s*quoted-printable\r?\n([\s\S]*)/i);
      if (te) {
        body = te[1].replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      }
      return body.trim();
    }
    return raw.slice(0, 8000).trim();
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    if (!chatId || chatId === "unknown") return;

    await dispatchChannelMessage(
      {
        channelKey: "email",
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
        channelKey: "email",
        gateway: this.gateway,
        elicitation: this.elicitation,
        permissions: this.permissions,
        render: renderEmailEvent,
        deliver: text => this.sendReply(chatId, text),
        logger: this.logger,
      },
      { interactionKey: chatId, sessionKey, message },
    );
  }

  private async sendReply(chatId: string, text: string): Promise<boolean> {
    const transporter = this.transporter;
    if (!transporter) return false;
    try {
      await transporter.sendMail({
        from: this.ownAddress,
        to: chatId,
        subject: this.defaultSubject,
        text,
      });
      return true;
    } catch (e) {
      this.logger?.error?.(`email: sendMail failed: ${e}`);
      return false;
    }
  }
}
