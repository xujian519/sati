import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAttachment, Gateway } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import {
  guessMimeTypeFromName,
  ImAttachmentDelivery,
  type PreparedImAttachment,
} from "../protocol/ImAttachmentDelivery.js";
import { ImAttachmentStore } from "../protocol/ImAttachmentStore.js";
import { ImChatSessionState } from "../protocol/ImChatSessionState.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import {
  ImLiveReplyController,
  type ImLiveReplyControllerOptions,
  type ImLiveReplyTransport,
} from "../protocol/ImLiveReplyController.js";
import { createVisibleErrorStatusDetail } from "../../../status/agentStatus.js";
import { FeishuSessionMapper, type FeishuSessionMapperState } from "./FeishuSessionMapper.js";
import {
  extractFeishuMessageText,
  isSupportedFeishuInboundType,
  parseDirectShape,
  parseV1Event,
  parseV2Event,
} from "./feishu-inbound.js";
import { authenticateFeishuWebhook } from "./feishu-webhook-auth.js";
import { type FeishuLiveCardActivityKind } from "./feishu-render.js";

// @larksuiteoapi/node-sdk 是可选依赖：这里仅类型化本文件用到的成员，避免 any 逃逸。
interface FeishuWsClientLike {
  start(args: { eventDispatcher: unknown }): Promise<unknown>;
  stop(): Promise<unknown> | void;
}
interface LarkSdkLike {
  EventDispatcher: new (
    options: Record<string, never>,
  ) => {
    register(handlers: Record<string, (data: unknown) => void>): unknown;
  };
  WSClient: new (options: {
    appId: string;
    appSecret: string;
    domain: string;
    loggerLevel?: number;
  }) => FeishuWsClientLike;
  Domain?: { Lark?: string; Feishu?: string };
  LoggerLevel?: { info?: number };
}

let Lark: LarkSdkLike | null = null;
let larkLoadAttempted = false;
async function loadLarkSdk(): Promise<LarkSdkLike | null> {
  if (Lark || larkLoadAttempted) return Lark;
  larkLoadAttempted = true;
  try {
    const mod = await import("@larksuiteoapi/node-sdk");
    Lark = ((mod as { default?: unknown }).default ?? mod) as LarkSdkLike;
  } catch {
    // 可选依赖加载失败：返回 null，触发 webhook 降级（fail-safe）。
    Lark = null;
  }
  return Lark;
}

const TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_PATH = "/open-apis/im/v1/messages?receive_id_type=chat_id";
const FEISHU_IMAGE_UPLOAD_PATH = "/open-apis/im/v1/images";
const FEISHU_FILE_UPLOAD_PATH = "/open-apis/im/v1/files";
const FEISHU_MESSAGES_PATH = "/open-apis/im/v1/messages";
const FEISHU_OPEN_API_BASE = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;
const PROCESSING_EMOJI = "OnIt";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SEEN_EVENTS_MAX = 2000;
const MAX_TEXT_MESSAGE_LENGTH = 4000;
const DEFAULT_LIVE_REPLY_CURSOR = " ▉";
/** 飞书单条消息最多编辑 20 次，超出后返回 230072。 */
const FEISHU_MAX_EDITS_PER_MESSAGE = 20;
const FEISHU_MIN_EDIT_INTERVAL_MS = 1_500;
const FEISHU_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const FEISHU_ATTACHMENT_FETCH_TIMEOUT_MS = 60_000;
const FEISHU_MAX_PENDING_TURNS_PER_CHAT = 20;
const FEISHU_MULTI_ATTACHMENT_BATCH_MS = 250;

export type FeishuOutboundMessage = {
  chatId: string;
  text: string;
};

export type FeishuLiveMessageHandle = {
  messageId: string;
  livePost: boolean;
};

export type FeishuConnectionMode = "stream" | "webhook";

export type FeishuChannelOptions = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verifyToken?: string;
  /**
   * "stream" (default): outbound WebSocket via @larksuiteoapi/node-sdk — no
   * public URL needed, identical to weixin-ilink long-polling.
   * "webhook": passive mode where Lark POSTs to /feishu/webhook (requires
   * a public tunnel).
   */
  connectionMode?: FeishuConnectionMode;
  /** "feishu" (open.feishu.cn) or "lark" (open.larksuite.com). */
  domainName?: "feishu" | "lark";
  mapper?: FeishuSessionMapper;
  /**
   * Optional override for outbound delivery (used in tests). When omitted the
   * channel calls Lark Open API directly.
   */
  send?: (message: FeishuOutboundMessage) => Promise<void>;
  liveReplyOptions?: Omit<ImLiveReplyControllerOptions<FeishuLiveMessageHandle>, "transport" | "onTransportError">;
  onStateChange?: (state: FeishuSessionMapperState) => void;
};

type ParsedEvent =
  | { kind: "url_verification"; challenge: string }
  | {
      kind: "message";
      eventId: string;
      chatId: string;
      text: string;
      messageId?: string;
      messageType?: string;
      content?: string;
    }
  | { kind: "ignore" }
  | { kind: "unauthorized" };

type FeishuInboundMessage = {
  chatId: string;
  text: string;
  eventId: string;
  messageId?: string;
  messageType?: string;
  content?: string;
};

type QueuedFeishuTurn = {
  sessionKey: string;
  message: string;
  projectKey?: string;
  attachments: ChannelAttachment[];
  messageId?: string;
  generation: number;
};

type FeishuInboundBatch = {
  messages: FeishuInboundMessage[];
  timer?: ReturnType<typeof setTimeout>;
  draining: boolean;
};

export class FeishuChannel implements ChannelAdapter {
  readonly channelKey = "feishu";

  private readonly mapper: FeishuSessionMapper;
  private readonly explicitSend?: (message: FeishuOutboundMessage) => Promise<void>;
  private readonly liveReplyOptions?: FeishuChannelOptions["liveReplyOptions"];
  private readonly onStateChange?: (state: FeishuSessionMapperState) => void;

  private appId: string;
  private appSecret: string;
  private encryptKey?: string;
  private verifyToken?: string;
  private connectionMode: FeishuConnectionMode;
  private domainName: "feishu" | "lark";

  private gateway?: Gateway;
  private logger?: ChannelLogger;

  private tokenCache?: { value: string; expiresAt: number };
  private tokenInflight?: Promise<string>;
  private readonly seenEvents = new Set<string>();
  private readonly activeChats = new Set<string>();
  private readonly chatState = new ImChatSessionState<QueuedFeishuTurn>({
    maxPendingTurns: FEISHU_MAX_PENDING_TURNS_PER_CHAT,
  });
  private readonly inboundBatches = new Map<string, FeishuInboundBatch>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();
  private readonly attachmentStore = new ImAttachmentStore({
    rootDir: join(homedir(), ".sati", "im-attachments"),
    channelKey: "feishu",
    maxBytes: FEISHU_MAX_ATTACHMENT_BYTES,
    fetchTimeoutMs: FEISHU_ATTACHMENT_FETCH_TIMEOUT_MS,
    fetchImpl: (url, init) => this.fetchApi(url, init),
  });

  private wsClient: FeishuWsClientLike | null = null;
  private stopped = true;
  private readonly stopAbort = new AbortController();
  private readonly activeReplies = new Map<string, ImLiveReplyController<FeishuLiveMessageHandle>>();
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private webhookAuthWarned = false;

  constructor(options: FeishuChannelOptions = {}) {
    this.mapper = options.mapper ?? new FeishuSessionMapper();
    this.explicitSend = options.send;
    this.liveReplyOptions = options.liveReplyOptions;
    this.appId = options.appId ?? "";
    this.appSecret = options.appSecret ?? "";
    this.encryptKey = options.encryptKey;
    this.verifyToken = options.verifyToken;
    this.connectionMode = options.connectionMode ?? "stream";
    this.domainName = options.domainName ?? "feishu";
    this.onStateChange = options.onStateChange;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const cfg = deps.config?.adapters?.feishu;
    if (cfg) {
      this.appId = this.appId || cfg.appId || "";
      this.appSecret = this.appSecret || cfg.appSecret || "";
      this.encryptKey = this.encryptKey ?? cfg.encryptKey;
      this.verifyToken = this.verifyToken ?? cfg.verifyToken;
    }

    if (!this.explicitSend && (!this.appId || !this.appSecret)) {
      this.logger?.warn?.(
        "feishu: appId/appSecret not configured; outbound replies will not be sent. " +
          "Configure adapters.feishu.appId/appSecret in sati.yaml.",
      );
      deps.reportChannelStatus?.("feishu", { state: "failed", message: "feishu: app credentials missing" });
      return { stop: async () => undefined };
    }

    this.stopped = false;
    if (this.connectionMode === "stream") {
      deps.reportChannelStatus?.("feishu", { state: "starting", message: "feishu: stream connecting" });
      const ok = await this.startStreamMode();
      if (!ok && !this.stopped) {
        deps.reportChannelStatus?.("feishu", { state: "failed", message: "feishu: stream connection failed" });
        this.logger?.warn?.(
          "feishu: stream mode failed to start; falling back to webhook-only " +
            "(set adapters.feishu.connectionMode: webhook in sati.yaml to silence this).",
        );
      } else if (ok) {
        deps.reportChannelStatus?.("feishu", { state: "connected", message: "feishu: stream connected" });
      }
    } else {
      if (!this.verifyToken && !this.encryptKey) {
        this.logger?.error?.(
          "feishu: webhook mode has neither verifyToken nor encryptKey configured; " +
            "every callback will be rejected with 401. Configure adapters.feishu.verifyToken " +
            "or adapters.feishu.encryptKey.",
        );
      }
      deps.reportChannelStatus?.("feishu", { state: "connected", message: "feishu: webhook ready" });
      this.logger?.info?.(
        `feishu: ready in webhook mode (appId=${maskAppId(this.appId)}); waiting for POST /feishu/webhook`,
      );
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`feishu: stopping (${reason ?? "no reason"})`);
        this.stopped = true;
        this.stopAbort.abort();
        const aborts = this.cancelActiveTurns(reason);
        const client = this.wsClient;
        this.wsClient = null;
        try {
          await client?.stop();
        } catch {
          // 停止时连接清理失败：引用随即置空，残留由 GC/系统回收（fail-safe）。
        }
        await aborts;
      },
    };
  }

  private async cancelActiveTurns(reason?: string): Promise<void> {
    const aborts: Promise<void>[] = [];
    const chats = new Set([...this.activeChats, ...this.inboundBatches.keys()]);
    for (const chatId of chats) {
      const run = this.chatState.activeRun(chatId);
      const batch = this.inboundBatches.get(chatId);
      if (batch) batch.messages.length = 0;
      this.resetChatInteractionState(chatId);
      if (run && this.gateway) {
        aborts.push(
          this.gateway
            .abortTurn({
              sessionKey: run.sessionKey,
              ...(run.runId ? { runId: run.runId } : {}),
              reason: reason ?? "channel stopped",
            })
            .catch((error: unknown) => {
              this.logger?.warn?.(`feishu: abort on stop failed: ${formatError(error)}`);
            }),
        );
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(aborts),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async startStreamMode(): Promise<boolean> {
    const sdk = await loadLarkSdk();
    if (!sdk) {
      this.logger?.error?.(
        "feishu: @larksuiteoapi/node-sdk failed to load; run `npm install @larksuiteoapi/node-sdk` " +
          "or set adapters.feishu.connectionMode: webhook",
      );
      return false;
    }

    try {
      const dispatcher = new sdk.EventDispatcher({}).register({
        "im.message.receive_v1": (data: unknown) => {
          this.logger?.info?.("feishu: ★ im.message.receive_v1 fired");
          void this.handleStreamEvent(data).catch((e: unknown) => {
            this.logger?.error?.(`feishu: stream event handler error: ${e}`);
          });
        },
      });

      const domain =
        this.domainName === "lark"
          ? (sdk.Domain?.Lark ?? "https://open.larksuite.com")
          : (sdk.Domain?.Feishu ?? "https://open.feishu.cn");

      this.wsClient = new sdk.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain,
        loggerLevel: sdk.LoggerLevel?.info ?? 2,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.logger?.info?.(`feishu: stream mode connected (appId=${maskAppId(this.appId)})`);
      return true;
    } catch (e) {
      this.logger?.error?.(`feishu: stream mode start failed: ${e}`);
      return false;
    }
  }

  private async handleStreamEvent(data: unknown): Promise<void> {
    if (this.stopped) return;
    const raw = data as Record<string, unknown>;
    const message = (raw.message ?? (raw as { event?: { message?: unknown } }).event?.message) as
      | { chat_id?: string; content?: string; message_type?: string; message_id?: string }
      | undefined;
    if (!message) return;
    if (!isSupportedFeishuInboundType(message.message_type)) return;

    const chatId = message.chat_id;
    if (!chatId || message.content === undefined) return;

    const text = extractFeishuMessageText(message.message_type, message.content);
    const messageId = message.message_id;
    const eventId = messageId ?? `stream:${chatId}:${Date.now()}`;

    if (this.seenEvents.has(eventId)) return;
    this.rememberEvent(eventId);

    this.enqueueInboundMessage({
      chatId,
      text,
      eventId,
      messageId,
      messageType: message.message_type,
      content: message.content,
    });
  }

  async handleWebhook(request: IncomingMessage, response: ServerResponse, body: string): Promise<boolean> {
    if (!this.gateway || this.stopped) {
      respondJson(response, 503, { error: "feishu_not_started" });
      return true;
    }

    const parsed = this.parseInbound(body, request.headers ?? {});

    if (parsed.kind === "unauthorized") {
      respondJson(response, 401, { error: "invalid_feishu_webhook_auth" });
      return true;
    }

    if (parsed.kind === "url_verification") {
      respondJson(response, 200, { challenge: parsed.challenge });
      return true;
    }

    if (parsed.kind === "ignore") {
      respondJson(response, 200, { ok: true });
      return true;
    }

    if (this.seenEvents.has(parsed.eventId)) {
      respondJson(response, 200, { ok: true, deduped: true });
      return true;
    }
    this.rememberEvent(parsed.eventId);

    respondJson(response, 200, { ok: true });
    this.enqueueInboundMessage(parsed);
    return true;
  }

  private enqueueInboundMessage(input: FeishuInboundMessage): void {
    if (this.stopped) return;
    if (this.tryHandlePendingInteraction(input)) return;

    const batch = this.inboundBatches.get(input.chatId) ?? { messages: [], draining: false };
    batch.messages.push(input);
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(
      () => {
        batch.timer = undefined;
        void this.drainInboundBatch(input.chatId).catch((error: unknown) => {
          this.logger?.error?.(`feishu: drainInboundBatch error: ${error}`);
        });
      },
      shouldBatchFeishuMessage(input) ? FEISHU_MULTI_ATTACHMENT_BATCH_MS : 0,
    );
    batch.timer.unref?.();
    this.inboundBatches.set(input.chatId, batch);
  }

  private tryHandlePendingInteraction(input: FeishuInboundMessage): boolean {
    if (!this.gateway) return false;
    if (this.elicitation.hasPending(input.chatId)) {
      void this.answerPendingElicitation(input.chatId, input.text).catch((e: unknown) => {
        this.logger?.error?.(`feishu: elicitation answer error: ${e}`);
      });
      return true;
    }
    if (this.permissions.hasPending(input.chatId)) {
      void this.answerPendingPermission(input.chatId, input.text).catch((e: unknown) => {
        this.logger?.error?.(`feishu: permission answer error: ${e}`);
      });
      return true;
    }
    return false;
  }

  private async answerPendingElicitation(chatId: string, text: string): Promise<void> {
    if (!this.gateway) return;
    const confirmation = await this.elicitation.answer(chatId, text, this.gateway);
    if (confirmation) await this.send({ chatId, text: confirmation });
  }

  private async answerPendingPermission(chatId: string, text: string): Promise<void> {
    if (!this.gateway) return;
    const confirmation = await this.permissions.answer(chatId, text, this.gateway);
    if (confirmation) await this.send({ chatId, text: confirmation });
  }

  private async drainInboundBatch(chatId: string): Promise<void> {
    const batch = this.inboundBatches.get(chatId);
    if (this.stopped || !batch || batch.draining) return;
    batch.draining = true;
    try {
      while (!this.stopped && batch.messages.length > 0) {
        const messages = batch.messages.splice(0);
        const grouped = groupFeishuInboundMessages(messages);
        for (const group of grouped) {
          await this.processInboundMessages(group);
        }
      }
    } finally {
      batch.draining = false;
      if (this.stopped || batch.messages.length === 0) {
        this.inboundBatches.delete(chatId);
      } else {
        this.inboundBatches.set(chatId, batch);
        void this.drainInboundBatch(chatId).catch((error: unknown) => {
          this.logger?.error?.(`feishu: drainInboundBatch retry error: ${error}`);
        });
      }
    }
  }

  private async processInboundMessages(inputs: FeishuInboundMessage[]): Promise<void> {
    if (!this.gateway || this.stopped) return;
    const first = inputs[0];
    if (!first) return;
    const chatId = first.chatId;
    const attachmentResults = await Promise.all(inputs.map(input => this.extractIncomingAttachments(input)));
    if (this.stopped) return;
    const attachments = attachmentResults.flatMap(result => result.attachments);
    const diagnostics = attachmentResults.flatMap(result => result.diagnostics);
    const text = mergeTextAndDiagnostics(
      inputs
        .map(input => input.text)
        .filter(Boolean)
        .join("\n"),
      diagnostics,
    );
    const messageText = text.trim() || (attachments.length > 0 ? "请查看我发送的附件。" : "");
    if (!messageText.trim() && attachments.length === 0) return;

    if (this.elicitation.hasPending(chatId)) {
      try {
        await this.answerPendingElicitation(chatId, messageText);
      } catch (e) {
        this.logger?.error?.(`feishu: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(chatId)) {
      try {
        await this.answerPendingPermission(chatId, messageText);
      } catch (e) {
        this.logger?.error?.(`feishu: permission answer error: ${e}`);
      }
      return;
    }

    const previousSessionKey = this.mapper.getSession(chatId);
    const mapped = this.mapper.resolve({ chatId, text: messageText });

    if (mapped.command === "new") {
      this.onStateChange?.(this.mapper.snapshot());
      const activeRun = this.chatState.activeRun(chatId);
      this.resetChatInteractionState(chatId);
      await this.gateway
        ?.abortTurn({
          sessionKey: activeRun?.sessionKey ?? previousSessionKey,
          ...(activeRun?.runId ? { runId: activeRun.runId } : {}),
        })
        .catch((error: unknown) => {
          this.logger?.warn?.(`feishu: abort previous session on /new failed: ${formatError(error)}`);
        });
      if (!mapped.message) {
        await this.send({ chatId, text: "已创建新会话。" });
        return;
      }
    }

    // Delegate system-level commands (e.g. /projects, /update, /status) to
    // the centralized registry — no need to handle them individually here.
    if (messageText.trim().startsWith("/")) {
      const handled = await executeChannelCommand(messageText, {
        gateway: this.gateway,
        chatId,
        channelKey: "feishu",
        reply: msg => this.send({ chatId, text: msg }),
        bindProject: projectKey => {
          this.mapper.bindProject(chatId, projectKey);
          this.onStateChange?.(this.mapper.snapshot());
        },
        getProject: () => this.mapper.getProject(chatId),
        resetSession: () => {
          this.mapper.resolve({ chatId, text: "/new" });
          this.onStateChange?.(this.mapper.snapshot());
        },
        logger: this.logger,
      });
      if (handled) return;
    }

    if (!mapped.message || this.stopped) return;

    if (this.activeChats.has(chatId)) {
      this.chatState.queueTurn(chatId, {
        sessionKey: mapped.sessionKey,
        message: mapped.message,
        projectKey: mapped.projectKey,
        attachments,
        messageId: first.messageId,
        generation: this.chatState.generation(chatId),
      });
      this.logger?.info?.(`feishu: chat ${chatId} already active, queued message`);
      return;
    }

    await this.runQueuedTurns(chatId, {
      sessionKey: mapped.sessionKey,
      message: mapped.message,
      projectKey: mapped.projectKey,
      attachments,
      messageId: first.messageId,
      generation: this.chatState.generation(chatId),
    });
  }

  private resetChatInteractionState(chatId: string): void {
    this.activeReplies.get(chatId)?.cancel();
    this.activeReplies.delete(chatId);
    const watchdog = this.watchdogs.get(chatId);
    if (watchdog) clearTimeout(watchdog);
    this.watchdogs.delete(chatId);
    this.chatState.resetForNewSession(chatId);
    this.elicitation.clear(chatId);
    this.permissions.clear(chatId);
    const batch = this.inboundBatches.get(chatId);
    if (batch?.timer) clearTimeout(batch.timer);
    this.inboundBatches.delete(chatId);
  }

  private async runQueuedTurns(chatId: string, firstTurn: QueuedFeishuTurn): Promise<void> {
    this.activeChats.add(chatId);
    try {
      let nextTurn: QueuedFeishuTurn | undefined = firstTurn;
      while (nextTurn && !this.stopped) {
        await this.processTurn(chatId, nextTurn);
        nextTurn = this.chatState.shiftTurn(chatId);
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async processTurn(chatId: string, turn: QueuedFeishuTurn): Promise<void> {
    if (!this.gateway) return;
    const isCurrentTurn = () => !this.stopped && this.chatState.isCurrent(chatId, turn.generation);
    if (!isCurrentTurn()) return;
    // “处理中”表情只是装饰：与回合并行发起，避免飞书往返拖慢交给 agent。
    const reactionPromise = turn.messageId ? this.addReaction(turn.messageId) : Promise.resolve(undefined);
    try {
      let activeRunId: string | undefined;
      let watchdogSettled = false;
      const liveReply = new ImLiveReplyController<FeishuLiveMessageHandle>({
        minEditIntervalMs: FEISHU_MIN_EDIT_INTERVAL_MS,
        ...this.liveReplyOptions,
        transport: this.createLiveReplyTransport(chatId, isCurrentTurn),
        onTransportError: (error, phase) => {
          this.logger?.warn?.(`feishu: live reply ${phase} failed: ${error}`);
        },
      });
      this.activeReplies.set(chatId, liveReply);
      this.chatState.setActiveRun(chatId, { sessionKey: turn.sessionKey, generation: turn.generation });
      const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? 600_000;
      const watchdog =
        turnTimeoutMs > 0
          ? setTimeout(() => {
              if (watchdogSettled || !isCurrentTurn()) return;
              watchdogSettled = true;
              this.logger?.warn?.(`feishu: live reply timed out for chat ${chatId}`);
              void liveReply.markTimedOut().catch((error: unknown) => {
                this.logger?.warn?.(`feishu: mark timeout failed: ${error}`);
              });
              void this.gateway
                ?.abortTurn({
                  sessionKey: turn.sessionKey,
                  ...(activeRunId ? { runId: activeRunId } : {}),
                  reason: "system:timeout",
                })
                .catch((error: unknown) => {
                  this.logger?.warn?.(`feishu: abort timeout turn failed: ${error}`);
                });
            }, turnTimeoutMs)
          : undefined;
      watchdog?.unref?.();
      if (watchdog) this.watchdogs.set(chatId, watchdog);
      try {
        for await (const event of this.gateway.submitTurn({
          sessionKey: turn.sessionKey,
          channelKey: "feishu",
          message: turn.message,
          ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
          allowPlanModeTools: false,
          timeoutMs: turnTimeoutMs,
          ...(turn.projectKey ? { projectKey: turn.projectKey } : {}),
        })) {
          if (!isCurrentTurn()) {
            if (event.type === "turn_started") {
              void this.gateway.abortTurn({ sessionKey: turn.sessionKey, runId: event.runId }).catch(() => undefined);
            }
            break;
          }
          if (event.type === "turn_started") {
            activeRunId = event.runId;
            this.chatState.setActiveRun(chatId, {
              sessionKey: turn.sessionKey,
              runId: activeRunId,
              generation: turn.generation,
            });
          }
          if (event.type === "elicitation_request") {
            const questionText = this.elicitation.capture(chatId, turn.sessionKey, event);
            await liveReply.pauseActivity();
            if (isCurrentTurn()) await this.send({ chatId, text: questionText });
            continue;
          }
          if (event.type === "permission_request") {
            const questionText = this.permissions.capture(chatId, turn.sessionKey, event);
            await liveReply.pauseActivity();
            if (questionText && isCurrentTurn()) await this.send({ chatId, text: questionText });
            continue;
          }
          if (event.type === "error" && event.code === "agent_aborted") {
            await liveReply.markAborted();
            continue;
          }
          if (event.type === "error" && event.code === "turn_timeout") {
            await liveReply.markTimedOut();
            continue;
          }
          if (event.type === "assistant_attachment") {
            await liveReply.flushSegment({ finalizeActivityOnly: false });
            if (isCurrentTurn()) await this.sendAttachment(chatId, event.attachment);
            continue;
          }
          await liveReply.handleEvent(event);
        }
      } catch (e) {
        if (!isCurrentTurn()) return;
        this.logger?.error?.(`feishu: submitTurn error: ${e}`);
        await liveReply.handleEvent({
          type: "agent_status",
          event: "channel_submit_failed",
          detail: createVisibleErrorStatusDetail({
            message: "Failed to process this message. Please retry.",
            code: "channel_submit_failed",
            userHint:
              "Sati failed before this IM turn could finish. Retry the message; if it repeats, check the channel and gateway logs.",
            scope: "channel",
            source: "im_channel",
            detail: {
              channel: "feishu",
            },
          }),
        });
      } finally {
        watchdogSettled = true;
        if (watchdog) clearTimeout(watchdog);
        if (this.watchdogs.get(chatId) === watchdog) this.watchdogs.delete(chatId);
      }

      if (isCurrentTurn()) {
        this.elicitation.clear(chatId);
        this.permissions.clear(chatId);
      }
      if (isCurrentTurn()) await liveReply.flushFinal();
      else liveReply.cancel();
    } finally {
      this.activeReplies.delete(chatId);
      if (turn.messageId) {
        const messageId = turn.messageId;
        void reactionPromise.then(reactionId => {
          if (reactionId) return this.removeReaction(messageId, reactionId);
          return undefined;
        });
      }
      const activeRun = this.chatState.activeRun(chatId);
      if (activeRun?.generation === turn.generation) {
        this.chatState.clearActiveRun(chatId);
      }
    }
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => this.sendTextMessage({ chatId, text }));
  }

  private createLiveReplyTransport(
    chatId: string,
    isCurrent: () => boolean,
  ): ImLiveReplyTransport<FeishuLiveMessageHandle> {
    const liveCursor = this.liveReplyOptions?.cursor ?? DEFAULT_LIVE_REPLY_CURSOR;
    let liveHandle: FeishuLiveMessageHandle | undefined;
    return {
      maxMessageLength: MAX_TEXT_MESSAGE_LENGTH,
      maxEditsPerMessage: FEISHU_MAX_EDITS_PER_MESSAGE,
      send: async text => {
        if (!isCurrent()) return false;
        const result = await this.sendLiveMessage(
          { chatId, text },
          {
            isFinal: !text.endsWith(liveCursor),
            activityKind: this.liveActivityKindFromText(text),
          },
        );
        if (result === false) return false;
        liveHandle = result ? { messageId: result.messageId, livePost: result.livePost } : undefined;
        return liveHandle;
      },
      edit: async (handle, text) => {
        if (!isCurrent()) return false;
        liveHandle = handle;
        return this.editLiveMessage(handle, text, {
          isFinal: !text.endsWith(liveCursor),
          activityKind: this.liveActivityKindFromText(text),
        });
      },
    };
  }

  private async send(message: FeishuOutboundMessage): Promise<void> {
    await this.sendTextMessage(message);
  }

  private async sendAttachment(
    chatId: string,
    attachment: Parameters<ImAttachmentDelivery["send"]>[0],
  ): Promise<boolean> {
    return new ImAttachmentDelivery({
      maxBytes: FEISHU_MAX_ATTACHMENT_BYTES,
      logger: this.logger,
      sendTextFallback: text => this.send({ chatId, text }),
      sendPrepared: prepared => this.uploadAndSendFeishuAttachment(chatId, prepared),
    }).send(attachment);
  }

  private async uploadAndSendFeishuAttachment(chatId: string, prepared: PreparedImAttachment): Promise<void> {
    if (!this.appId || !this.appSecret) throw new Error("feishu app credentials missing");
    if (prepared.fileType === "image") {
      const imageKey = await this.uploadFeishuImage(prepared);
      await this.sendRawMessage(chatId, "image", { image_key: imageKey });
      return;
    }
    const fileKey = await this.uploadFeishuFile(prepared);
    await this.sendRawMessage(chatId, "file", { file_key: fileKey });
  }

  private async uploadFeishuImage(prepared: PreparedImAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set("image_type", "message");
    form.set(
      "image",
      new Blob([new Uint8Array(prepared.buffer)], { type: prepared.mimeType ?? "application/octet-stream" }),
      prepared.name,
    );
    const res = await this.fetchApi(this.openApiUrl(FEISHU_IMAGE_UPLOAD_PATH), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { image_key?: string } };
    if (!res.ok || json.code !== 0 || !json.data?.image_key) {
      if (json.code === 99991663 || json.code === 99991664) this.tokenCache = undefined;
      throw new Error(`feishu image upload failed code=${json.code} msg=${json.msg}`);
    }
    return json.data.image_key;
  }

  private async uploadFeishuFile(prepared: PreparedImAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set("file_type", inferFeishuFileType(prepared.name, prepared.mimeType));
    form.set("file_name", prepared.name);
    form.set(
      "file",
      new Blob([new Uint8Array(prepared.buffer)], { type: prepared.mimeType ?? "application/octet-stream" }),
      prepared.name,
    );
    const res = await this.fetchApi(this.openApiUrl(FEISHU_FILE_UPLOAD_PATH), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { file_key?: string } };
    if (!res.ok || json.code !== 0 || !json.data?.file_key) {
      if (json.code === 99991663 || json.code === 99991664) this.tokenCache = undefined;
      throw new Error(`feishu file upload failed code=${json.code} msg=${json.msg}`);
    }
    return json.data.file_key;
  }

  private async extractIncomingAttachments(input: FeishuInboundMessage): Promise<{
    attachments: ChannelAttachment[];
    diagnostics: string[];
  }> {
    const messageType = input.messageType;
    if (messageType !== "image" && messageType !== "file") {
      if (messageType && !isSupportedFeishuInboundType(messageType)) {
        return {
          attachments: [],
          diagnostics: [`[Attachment diagnostics] 飞书 ${messageType} 消息暂不支持附件解析。`],
        };
      }
      return { attachments: [], diagnostics: [] };
    }
    if (!input.messageId) {
      return { attachments: [], diagnostics: ["[Attachment diagnostics] 飞书附件缺少 message_id，无法下载。"] };
    }

    try {
      const content = parseJsonObject(input.content);
      const token = await this.getTenantAccessToken().catch((error: unknown) => {
        throw new Error(`tenant token unavailable: ${formatError(error)}`);
      });
      if (messageType === "image") {
        const imageKey = readString(content.image_key);
        if (!imageKey) throw new Error("image_key missing");
        const url = this.openApiUrl(
          `${FEISHU_MESSAGES_PATH}/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
        );
        const attachment = await this.attachmentStore.saveFromUrl({
          url,
          chatId: input.chatId,
          messageId: input.messageId,
          type: "image",
          name: imageKey,
          metadata: { channelKey: "feishu", chatId: input.chatId, messageId: input.messageId, imageKey },
          headers: { Authorization: `Bearer ${token}` },
        });
        return { attachments: [attachment], diagnostics: [] };
      }

      const fileKey = readString(content.file_key);
      if (!fileKey) throw new Error("file_key missing");
      const name = readString(content.file_name) ?? readString(content.name) ?? fileKey;
      const bytes = readNumber(content.size);
      const url = this.openApiUrl(
        `${FEISHU_MESSAGES_PATH}/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`,
      );
      const attachment = await this.attachmentStore.saveFromUrl({
        url,
        chatId: input.chatId,
        messageId: input.messageId,
        type: "file",
        name,
        bytes,
        mimeType: guessMimeTypeFromName(name),
        metadata: { channelKey: "feishu", chatId: input.chatId, messageId: input.messageId, fileKey },
        headers: { Authorization: `Bearer ${token}` },
      });
      return { attachments: [attachment], diagnostics: [] };
    } catch (error) {
      this.logger?.warn?.(`feishu: attachment download failed: ${formatError(error)}`);
      return { attachments: [], diagnostics: [`[Attachment diagnostics] 飞书附件下载失败：${formatError(error)}`] };
    }
  }

  private async sendLiveMessage(
    message: FeishuOutboundMessage,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<FeishuLiveMessageHandle | undefined | false> {
    const messageId = await this.sendPostMessage(message.chatId, message.text, options);
    if (messageId !== false) return { messageId, livePost: true };
    const fallbackMessageId = await this.sendTextMessage(message);
    if (fallbackMessageId === false || fallbackMessageId === undefined) return fallbackMessageId;
    return { messageId: fallbackMessageId, livePost: false };
  }

  private async sendTextMessage(message: FeishuOutboundMessage): Promise<string | undefined | false> {
    if (this.stopAbort.signal.aborted) return false;
    if (this.explicitSend) {
      await this.explicitSend(message);
      return undefined;
    }
    return this.sendRawMessage(message.chatId, "text", { text: message.text });
  }

  private async sendRawMessage(
    chatId: string,
    msgType: "text" | "image" | "file",
    content: Record<string, unknown>,
  ): Promise<string | undefined | false> {
    if (!this.appId || !this.appSecret) {
      this.logger?.warn?.("feishu: cannot send — appId/appSecret missing");
      return false;
    }

    try {
      const token = await this.getTenantAccessToken();
      const res = await this.fetchApi(this.openApiUrl(SEND_MESSAGE_PATH), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify(content),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.error?.(`feishu: send ${msgType} failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id;
    } catch (e) {
      this.logger?.error?.(`feishu: send ${msgType} threw: ${e}`);
    }
    return false;
  }

  private async editLiveMessage(
    handle: FeishuLiveMessageHandle,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<boolean> {
    if (!handle.messageId || !this.appId || !this.appSecret) return false;
    if (!handle.livePost) return this.editTextMessage(handle.messageId, text);

    const ok = await this.editPostMessage(handle.messageId, text, options);
    if (ok !== false) return true;
    handle.livePost = false;
    return this.editTextMessage(handle.messageId, text);
  }

  private async editTextMessage(messageId: string, text: string): Promise<boolean> {
    if (!messageId || !this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await this.fetchApi(this.openApiUrl(`${FEISHU_MESSAGES_PATH}/${encodeURIComponent(messageId)}`), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: update message failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: update message threw: ${e}`);
      return false;
    }
  }

  private async sendPostMessage(
    chatId: string,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<string | false> {
    if (!this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await this.fetchApi(this.openApiUrl(SEND_MESSAGE_PATH), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(renderFeishuLivePost(text, options)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: send post failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id ?? false;
    } catch (e) {
      this.logger?.warn?.(`feishu: send post threw: ${e}`);
      return false;
    }
  }

  private async editPostMessage(
    messageId: string,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<boolean> {
    if (!messageId || !this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await this.fetchApi(this.openApiUrl(`${FEISHU_MESSAGES_PATH}/${encodeURIComponent(messageId)}`), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "post",
          content: JSON.stringify(renderFeishuLivePost(text, options)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: update post failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: update post threw: ${e}`);
      return false;
    }
  }

  private liveActivityKindFromText(text: string): FeishuLiveCardActivityKind {
    if (text.includes("正在执行工具")) return "tool";
    if (text.includes("正在处理子任务")) return "subagent";
    return "thinking";
  }

  private async addReaction(messageId: string): Promise<string | undefined> {
    if (!this.appId || !this.appSecret) return undefined;
    try {
      const token = await this.getTenantAccessToken();
      const res = await this.fetchApi(
        this.openApiUrl(`${FEISHU_MESSAGES_PATH}/${encodeURIComponent(messageId)}/reactions`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reaction_type: { emoji_type: PROCESSING_EMOJI } }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        data?: { reaction_id?: string };
      };
      if (json.code === 0 && json.data?.reaction_id) {
        return json.data.reaction_id;
      }
      this.logger?.info?.(`feishu: addReaction non-zero code=${json.code}`);
    } catch (e) {
      this.logger?.info?.(`feishu: addReaction failed: ${e}`);
    }
    return undefined;
  }

  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.appId || !this.appSecret) return;
    try {
      const token = await this.getTenantAccessToken();
      await this.fetchApi(
        this.openApiUrl(
          `${FEISHU_MESSAGES_PATH}/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
        ),
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (e) {
      this.logger?.info?.(`feishu: removeReaction failed: ${e}`);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.tokenCache.value;
    }
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        const res = await this.fetchApi(this.openApiUrl(TENANT_TOKEN_PATH), {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        });
        const json = (await res.json()) as {
          code?: number;
          msg?: string;
          tenant_access_token?: string;
          expire?: number;
        };
        if (json.code !== 0 || !json.tenant_access_token) {
          throw new Error(`tenant_access_token failed: code=${json.code} msg=${json.msg}`);
        }
        const expireSec = typeof json.expire === "number" ? json.expire : 7200;
        this.tokenCache = {
          value: json.tenant_access_token,
          expiresAt: Date.now() + expireSec * 1000,
        };
        return this.tokenCache.value;
      } finally {
        this.tokenInflight = undefined;
      }
    })();

    return this.tokenInflight;
  }

  private fetchApi(url: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.any([
        this.stopAbort.signal,
        AbortSignal.timeout(FEISHU_ATTACHMENT_FETCH_TIMEOUT_MS),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  }

  private openApiUrl(path: string): string {
    return `${FEISHU_OPEN_API_BASE[this.domainName] ?? FEISHU_OPEN_API_BASE.feishu}${path}`;
  }

  private rejectWebhookAuth(reason: string): ParsedEvent {
    if (!this.webhookAuthWarned) {
      this.webhookAuthWarned = true;
      this.logger?.warn?.(
        `feishu: rejected webhook callback (${reason}); check adapters.feishu.verifyToken/encryptKey`,
      );
    }
    return { kind: "unauthorized" };
  }

  private parseInbound(body: string, headers: IncomingMessage["headers"]): ParsedEvent {
    const auth = authenticateFeishuWebhook({
      body,
      headers,
      ...(this.verifyToken ? { verifyToken: this.verifyToken } : {}),
      ...(this.encryptKey ? { encryptKey: this.encryptKey } : {}),
    });
    if (auth.kind === "ignore") return { kind: "ignore" };
    if (auth.kind === "unauthorized") return this.rejectWebhookAuth(auth.reason);
    if (auth.challenge) return { kind: "url_verification", challenge: auth.challenge };

    const raw = auth.payload;
    const direct = parseDirectShape(raw);
    if (direct) return direct;

    const v2 = parseV2Event(raw);
    if (v2) return v2;

    const v1 = parseV1Event(raw);
    if (v1) return v1;

    return { kind: "ignore" };
  }

  private rememberEvent(eventId: string): void {
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > SEEN_EVENTS_MAX) {
      const first = this.seenEvents.values().next().value;
      if (first) this.seenEvents.delete(first);
    }
  }
}

function shouldBatchFeishuMessage(input: FeishuInboundMessage): boolean {
  return input.messageType === "image" || input.messageType === "file";
}

function groupFeishuInboundMessages(messages: FeishuInboundMessage[]): FeishuInboundMessage[][] {
  const groups: FeishuInboundMessage[][] = [];
  let attachmentGroup: FeishuInboundMessage[] = [];
  for (const message of messages) {
    if (shouldBatchFeishuMessage(message)) {
      attachmentGroup.push(message);
      continue;
    }
    if (attachmentGroup.length > 0) {
      groups.push(attachmentGroup);
      attachmentGroup = [];
    }
    groups.push([message]);
  }
  if (attachmentGroup.length > 0) groups.push(attachmentGroup);
  return groups;
}

function mergeTextAndDiagnostics(text: string, diagnostics: string[]): string {
  if (diagnostics.length === 0) return text;
  return [text.trim(), ...diagnostics].filter(Boolean).join("\n\n");
}

function parseJsonObject(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // 内容非合法 JSON：返回空对象（fail-safe）。
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferFeishuFileType(name: string, mimeType: string | undefined): string {
  const lower = name.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "doc";
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) return "xls";
  if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "ppt";
  return "stream";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function renderFeishuLivePost(
  text: string,
  options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
): Record<string, unknown> {
  const content = normalizeLivePostText(text, options);
  return {
    zh_cn: {
      content: [[{ tag: "text", text: content }]],
    },
  };
}

function normalizeLivePostText(
  text: string,
  options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
): string {
  const stripped = text.replace(/\s*▉\s*$/u, "").trim();
  const body =
    stripped ||
    (options.isFinal ? "处理完成，但没有可见回复。" : livePostActivityLabel(options.activityKind ?? "thinking"));
  if (body.length <= MAX_TEXT_MESSAGE_LENGTH) return body;
  return `${body.slice(0, Math.max(0, MAX_TEXT_MESSAGE_LENGTH - 12)).trimEnd()}\n…（已截断）`;
}

function livePostActivityLabel(kind: FeishuLiveCardActivityKind): string {
  switch (kind) {
    case "tool":
      return "正在执行工具…";
    case "subagent":
      return "正在处理子任务…";
    case "thinking":
    default:
      return "正在思考…";
  }
}

function maskAppId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
