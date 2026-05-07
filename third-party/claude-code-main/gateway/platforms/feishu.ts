/**
 * Feishu / Lark platform adapter.
 *
 * - WebSocket long connection (default): requires @larksuiteoapi/node-sdk (or @larksuite/node-sdk)
 * - HTTP webhook: optional SDK for receive; outbound uses REST
 *
 * Credentials: appId, appSecret in config.extra (or FEISHU_APP_ID / FEISHU_APP_SECRET env).
 */

import { createRequire } from 'node:module'
import http from 'node:http'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, MessageEvent } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const require = createRequire(import.meta.url)

let Lark: any
try {
  Lark = require('@larksuiteoapi/node-sdk')
} catch {
  try {
    Lark = require('@larksuite/node-sdk')
  } catch {
    Lark = null
  }
}

const MAX_MESSAGE_LENGTH = 20000
const FEISHU_DOMAIN = 'https://open.feishu.cn'
const LARK_DOMAIN = 'https://open.larksuite.com'

export function checkFeishuRequirements(): boolean {
  return typeof fetch === 'function'
}

function env(name: string): string {
  return String(process.env[name] ?? '').trim()
}

function getExtra(config: PlatformConfig, key: string): unknown {
  return config.extra?.[key]
}

export class FeishuAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH
  supportsStreaming = false

  private readonly appId: string
  private readonly appSecret: string
  private readonly domainName: string
  private readonly connectionMode: string
  private readonly verificationToken: string
  private readonly webhookHost: string
  private readonly webhookPort: number
  private readonly webhookPath: string

  private baseUrl: string
  private tenantToken: string | null = null
  private tokenExpiresAt = 0
  private wsClient: { start: (opts: unknown) => void; stop?: () => void } | null = null
  private httpServer: http.Server | null = null
  constructor(config: PlatformConfig) {
    super(config, Platform.FEISHU)
    const extra = config.extra ?? {}
    this.appId = String(getExtra(config, 'appId') ?? getExtra(config, 'app_id') ?? env('FEISHU_APP_ID'))
    this.appSecret = String(
      getExtra(config, 'appSecret') ?? getExtra(config, 'app_secret') ?? env('FEISHU_APP_SECRET'),
    )
    this.domainName = String(getExtra(config, 'domain_name') ?? getExtra(config, 'domainName') ?? 'feishu')
      .toLowerCase()
    this.connectionMode = String(
      getExtra(config, 'connection_mode') ?? env('FEISHU_CONNECTION_MODE') ?? 'websocket',
    )
      .toLowerCase()
    this.verificationToken = String(
      getExtra(config, 'verification_token') ?? getExtra(config, 'verificationToken') ?? env('FEISHU_VERIFICATION_TOKEN'),
    )
    this.webhookHost = String(getExtra(config, 'webhook_host') ?? env('FEISHU_WEBHOOK_HOST') ?? '127.0.0.1')
    this.webhookPort = Number(getExtra(config, 'webhook_port') ?? env('FEISHU_WEBHOOK_PORT') ?? 8765)
    this.webhookPath = String(getExtra(config, 'webhook_path') ?? env('FEISHU_WEBHOOK_PATH') ?? '/feishu/webhook')
    this.baseUrl = this.domainName === 'lark' ? LARK_DOMAIN : FEISHU_DOMAIN
  }

  async connect(): Promise<boolean> {
    if (!this.appId || !this.appSecret) {
      this.setFatalError('feishu_credentials', 'Feishu appId and appSecret are required in config.extra', false)
      return false
    }

    try {
      if (this.connectionMode === 'webhook') {
        await this.startWebhookServer()
        await this.ensureToken()
        this.markConnected()
        return true
      }

      if (!Lark) {
        this.setFatalError(
          'feishu_missing_sdk',
          'WebSocket mode requires @larksuiteoapi/node-sdk. Install it or set FEISHU_CONNECTION_MODE=webhook',
          true,
        )
        return false
      }

      const eventDispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
          console.log('[feishu] ★ im.message.receive_v1 event fired')
          setImmediate(() => void this.dispatchImMessageReceiveV1(data).catch(e => console.error('[feishu]', e)))
        },
        'card.action.trigger': (data: unknown) => {
          console.log('[feishu] ★ card.action.trigger event fired')
          setImmediate(() => void this.handleCardAction(data).catch(e => console.error('[feishu] card action error:', e)))
        },
      })

      const domain = this.domainName === 'lark'
        ? (Lark.Domain?.Lark ?? this.baseUrl)
        : (Lark.Domain?.Feishu ?? this.baseUrl)

      this.wsClient = new Lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: Lark.LoggerLevel?.info ?? 2,
        domain,
      })

      // start() resolves once WebSocket handshake completes
      await this.wsClient.start({ eventDispatcher })
      await this.ensureToken()
      this.markConnected()
      return true
    } catch (e) {
      const msg = String(e)
      this.setFatalError('feishu_connect', msg, true)
      return false
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.wsClient && typeof this.wsClient.stop === 'function') {
        this.wsClient.stop()
      }
    } catch {}
    this.wsClient = null

    if (this.httpServer) {
      await new Promise<void>(resolve => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.tenantToken = null
    this.markDisconnected()
  }

  private async startWebhookServer(): Promise<void> {
    this.httpServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== this.webhookPath) {
        res.writeHead(404)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        void (async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const payload = JSON.parse(raw) as Record<string, unknown>
            if (payload.type === 'url_verification') {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ challenge: payload.challenge ?? '' }))
              return
            }
            if (this.verificationToken) {
              const header = (payload.header ?? {}) as Record<string, unknown>
              const tok = String(header.token ?? payload.token ?? '')
              if (tok !== this.verificationToken) {
                res.writeHead(401)
                res.end('Invalid verification token')
                return
              }
            }
            const header = (payload.header ?? {}) as Record<string, unknown>
            const eventType = String(header.event_type ?? '')
            if (eventType === 'im.message.receive_v1') {
              const data = { event: (payload as { event?: unknown }).event }
              setImmediate(() =>
                void this.dispatchImMessageReceiveV1(data).catch(e => console.error('[feishu]', e)),
              )
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ code: 0, msg: 'ok' }))
          } catch (e) {
            res.writeHead(400)
            res.end(String(e))
          }
        })()
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.webhookPort, this.webhookHost, () => resolve())
      this.httpServer!.on('error', reject)
    })
    console.log(`[gateway] Feishu webhook listening http://${this.webhookHost}:${this.webhookPort}${this.webhookPath}`)
  }

  private async dispatchImMessageReceiveV1(data: unknown): Promise<void> {
    console.log('[feishu] Raw event data:', JSON.stringify(data, null, 2)?.slice(0, 2000))

    const raw = data as Record<string, unknown>

    // Node SDK flattens the event: sender/message are top-level, not nested in .event
    const msg = (raw.message ?? (raw as any).event?.message) as Record<string, unknown> | undefined
    const senderObj = (raw.sender ?? (raw as any).event?.sender) as
      | { sender_id?: { open_id?: string; user_id?: string; union_id?: string } }
      | undefined

    if (!msg) {
      console.log('[feishu] No message field found in event data, skipping')
      return
    }

    const chatId = String(msg.chat_id ?? '')
    const messageId = String(msg.message_id ?? '')
    const msgType = String(msg.message_type ?? msg.msg_type ?? 'text').toLowerCase()
    let text = ''
    let mtype = MessageType.TEXT

    if (msgType === 'text') {
      try {
        const c = JSON.parse(String(msg.content ?? '{}')) as { text?: string }
        text = c.text ?? ''
      } catch {
        text = String(msg.content ?? '')
      }
    } else if (msgType === 'image') {
      mtype = MessageType.PHOTO
      try {
        const c = JSON.parse(String(msg.content ?? '{}')) as { image_key?: string }
        text = c.image_key ? `[image:${c.image_key}]` : '[image]'
      } catch {
        text = '[image]'
      }
    } else if (msgType === 'interactive') {
      text = '[interactive card]'
    } else {
      text = `[${msgType}]`
    }

    if (!text && msgType === 'text') return

    const sender = senderObj?.sender_id
    const userId = String(sender?.open_id ?? sender?.user_id ?? sender?.union_id ?? '')

    const chatTypeRaw = String(msg.chat_type ?? '')
    const chatType: MessageEvent['source']['chatType'] =
      chatTypeRaw === 'group' ? 'group' : chatTypeRaw === 'topic' ? 'thread' : 'dm'

    console.log(`[feishu] Message received: chatId=${chatId}, userId=${userId}, type=${msgType}, text="${text.slice(0, 100)}"`)

    const event = createMessageEvent(text, {
      platform: Platform.FEISHU,
      chatId,
      chatType,
      userId: userId || undefined,
      userName: userId || undefined,
    })
    event.messageId = messageId
    event.messageType = mtype
    await this.handleMessage(event)
  }

  private async handleCardAction(data: unknown): Promise<void> {
    console.log('[feishu] Card action data:', JSON.stringify(data, null, 2)?.slice(0, 2000))

    const raw = data as Record<string, unknown>
    const action = raw.action as Record<string, unknown> | undefined
    if (!action) return

    let valueStr = action.value as string | Record<string, unknown> | undefined
    let value: Record<string, unknown>
    try {
      value = typeof valueStr === 'string' ? JSON.parse(valueStr) : (valueStr as Record<string, unknown>)
    } catch {
      return
    }

    if (!value || value.action !== 'select_project') return

    const openId = String(
      (raw.open_id ?? (raw as any).operator?.open_id ?? '') as string
    )
    const chatId = String(
      (raw.open_chat_id ?? (raw as any).context?.open_chat_id ?? '') as string
    )

    if (!chatId) return

    const projectIndex = value.index as number
    const projectName = value.name as string
    const projectPath = value.path as string

    console.log(`[feishu] Card action: user=${openId} selected project ${projectIndex}: ${projectName} -> ${projectPath}`)

    const event = createMessageEvent(`/select_project ${projectIndex}`, {
      platform: Platform.FEISHU,
      chatId,
      chatType: 'dm',
      userId: openId || undefined,
      userName: openId || undefined,
    })
    event.internal = true
    ;(event as any)._projectSelection = { name: projectName, path: projectPath }
    await this.handleMessage(event)
  }

  private async ensureToken(): Promise<string> {
    const now = Date.now() / 1000
    if (this.tenantToken && this.tokenExpiresAt > now + 60) return this.tenantToken

    const res = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const j = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number; msg?: string }
    if (j.code !== 0 || !j.tenant_access_token) {
      throw new Error(j.msg ?? 'Failed to obtain tenant_access_token')
    }
    this.tenantToken = j.tenant_access_token
    this.tokenExpiresAt = now + (j.expire ?? 7200)
    return this.tenantToken
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    void _replyTo
    try {
      const token = await this.ensureToken()
      const msgType = String(metadata?.msgType ?? metadata?.msg_type ?? 'text').toLowerCase()
      let body: Record<string, unknown>

      if (msgType === 'interactive' && metadata?.card) {
        body = {
          receive_id: chatId,
          msg_type: 'interactive',
          content: typeof metadata.card === 'string' ? metadata.card : JSON.stringify(metadata.card),
        }
      } else if (msgType === 'image' && metadata?.image_key) {
        body = {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: String(metadata.image_key) }),
        }
      } else {
        body = {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: content.slice(0, MAX_MESSAGE_LENGTH) }),
        }
      }

      const qs = new URLSearchParams({ receive_id_type: 'chat_id' })

      const url = `${this.baseUrl}/open-apis/im/v1/messages?${qs.toString()}`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const j = (await res.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
      if (j.code !== 0) {
        return { success: false, error: j.msg ?? `code ${j.code}`, rawResponse: j }
      }
      return { success: true, messageId: j.data?.message_id, rawResponse: j }
    } catch (e) {
      return { success: false, error: String(e), retryable: true }
    }
  }

  async editMessage(_chatId: string, messageId: string, content: string): Promise<SendResult> {
    void _chatId
    try {
      const token = await this.ensureToken()
      const url = `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text: content.slice(0, MAX_MESSAGE_LENGTH) }),
        }),
      })
      const j = (await res.json()) as { code?: number; msg?: string }
      if (j.code !== 0) {
        return { success: false, error: j.msg ?? `code ${j.code}`, rawResponse: j }
      }
      return { success: true, messageId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    try {
      const token = await this.ensureToken()
      const res = await fetch(`${this.baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = (await res.json()) as {
        code?: number
        data?: { name?: string; chat_mode?: string }
      }
      if (j.code !== 0 || !j.data) {
        return { name: chatId, type: 'dm' }
      }
      const mode = j.data.chat_mode
      const type: ChatInfo['type'] = mode === 'group' ? 'group' : 'dm'
      return { name: j.data.name ?? chatId, type, chatMode: mode }
    } catch {
      return { name: chatId, type: 'dm' }
    }
  }
}
