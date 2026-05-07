/**
 * BlueBubbles — REST client for the local BlueBubbles server (iMessage on macOS).
 *
 * Inbound: poll GET /api/v1/message or optional webhook push.
 * Outbound: POST /api/v1/message/text
 */

import { randomUUID } from 'node:crypto'
import * as http from 'node:http'
import { URL } from 'node:url'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const POLL_MS = 2500
const MESSAGE_LIMIT = 50

function extra(config: PlatformConfig, key: string): unknown {
  return config.extra?.[key]
}

function env(k: string): string {
  return String(process.env[k] ?? '').trim()
}

export class BlueBubblesAdapter extends BasePlatformAdapter {
  private serverUrl: string
  private password: string
  private webhookPort: number
  private useWebhook: boolean

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollAbort = new AbortController()
  private webhookServer: http.Server | null = null
  private lastTimestamp = 0
  private seenGuids = new Set<string>()

  constructor(config: PlatformConfig) {
    super(config, Platform.BLUEBUBBLES)
    const ex = config.extra ?? {}
    this.serverUrl = String(ex.serverUrl ?? env('BLUEBUBBLES_SERVER_URL')).replace(/\/+$/, '')
    this.password = String(ex.password ?? env('BLUEBUBBLES_PASSWORD'))
    const wp = Number(ex.webhookPort ?? ex.webhook_port ?? 0)
    this.webhookPort = Number.isFinite(wp) && wp > 0 ? Math.floor(wp) : 0
    this.useWebhook = Boolean(ex.useWebhook ?? ex.use_webhook)
  }

  async connect(): Promise<boolean> {
    if (!this.serverUrl || !this.password) {
      this.setFatalError(
        'bluebubbles_config',
        'config.extra.serverUrl and password (or BLUEBUBBLES_* env) are required',
        false,
      )
      return false
    }

    this.pollAbort = new AbortController()
    this.seenGuids.clear()
    this.lastTimestamp = Math.floor(Date.now() / 1000) - 5

    if (this.useWebhook && this.webhookPort > 0) {
      try {
        this.webhookServer = http.createServer((req, res) => void this.onWebhook(req, res))
        await new Promise<void>((resolve, reject) => {
          this.webhookServer!.once('error', reject)
          this.webhookServer!.listen(this.webhookPort, '127.0.0.1', () => resolve())
        })
        console.log(`[bluebubbles] webhook on http://127.0.0.1:${this.webhookPort}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.setFatalError('bluebubbles_webhook', msg, false)
        return false
      }
    } else {
      this.pollTimer = setInterval(() => void this.pollMessages(), POLL_MS)
      void this.pollMessages()
    }

    this.markConnected()
    return true
  }

  private async onWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(Buffer.from(c))
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      await this.dispatchPayload(raw)
    } catch (e) {
      console.error('[bluebubbles] webhook:', e)
      res.writeHead(400).end()
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.isConnected) return
    const base = new URL('/api/v1/message', this.serverUrl)
    base.searchParams.set('password', this.password)
    base.searchParams.set('after', String(this.lastTimestamp))
    base.searchParams.set('limit', String(MESSAGE_LIMIT))

    try {
      const res = await fetch(base.toString(), { signal: this.pollAbort.signal })
      if (!res.ok) {
        console.warn(`[bluebubbles] poll ${res.status}`)
        return
      }
      const data = (await res.json()) as unknown
      const rows = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)
          ? (data as { data: unknown[] }).data
          : data && typeof data === 'object' && Array.isArray((data as { messages?: unknown[] }).messages)
            ? (data as { messages: unknown[] }).messages
            : []

      let maxTs = this.lastTimestamp
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const o = row as Record<string, unknown>
        const guid = String(o.guid ?? o.id ?? '')
        if (guid && this.seenGuids.has(guid)) continue
        if (guid) this.seenGuids.add(guid)

        const ts = num(o.dateCreated ?? o.timestamp ?? o.time)
        if (ts != null && ts > maxTs) maxTs = ts

        await this.dispatchPayload(o)
      }
      if (maxTs > this.lastTimestamp) this.lastTimestamp = maxTs
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      console.error('[bluebubbles] poll error:', e)
    }
  }

  private async dispatchPayload(o: Record<string, unknown>): Promise<void> {
    const isFromMe = Boolean(o.isFromMe ?? o.is_from_me)
    if (isFromMe) return

    const text = String(o.text ?? o.body ?? o.message ?? '').trim()
    const chatGuid = String(o.chatGuid ?? o.chat_guid ?? o.chats?.[0] ?? '')
    if (!chatGuid) return

    const source = {
      platform: Platform.BLUEBUBBLES,
      chatId: chatGuid,
      chatName: o.chatName != null ? String(o.chatName) : o.displayName != null ? String(o.displayName) : undefined,
      chatType: o.isGroup === true || o.style === 43 ? ('group' as const) : ('dm' as const),
      userId: o.handle != null ? String(o.handle) : undefined,
      userName: o.senderName != null ? String(o.senderName) : undefined,
    }

    const base = createMessageEvent(text || '[message]', source)
    const attachments = Array.isArray(o.attachments) ? o.attachments : []
    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue
      const u = (a as { transferName?: string; mimeType?: string }).transferName
      if (u) mediaUrls.push(String(u))
      const mt = (a as { mimeType?: string }).mimeType
      if (mt) mediaTypes.push(String(mt))
    }

    const event = {
      ...base,
      messageId: o.guid != null ? String(o.guid) : undefined,
      messageType: mediaUrls.length ? MessageType.PHOTO : MessageType.TEXT,
      mediaUrls,
      mediaTypes,
      replyToMessageId: o.threadId != null ? String(o.threadId) : undefined,
    }
    void this.handleMessage(event)
  }

  async disconnect(): Promise<void> {
    this.pollAbort.abort()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.webhookServer) {
      await new Promise<void>(resolve => this.webhookServer!.close(() => resolve()))
      this.webhookServer = null
    }
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const url = new URL('/api/v1/message/text', this.serverUrl)
    try {
      const tempGuid = (metadata?.tempGuid as string) ?? randomUUID()
      const body: Record<string, unknown> = {
        chatGuid: chatId,
        message: this.formatMessage(content),
        tempGuid,
      }
      if (metadata?.effectId != null) body.effectId = metadata.effectId

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.password ? { Authorization: `Bearer ${this.password}` } : {}),
        },
        body: JSON.stringify({ ...body, password: this.password }),
        signal: AbortSignal.timeout(120_000),
      })
      const raw = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = (raw as { message?: string; error?: string }).message ?? (raw as { error?: string }).error ?? res.statusText
        return { success: false, error: String(err), rawResponse: raw, retryable: res.status >= 500 }
      }
      const guid = (raw as { guid?: string; messageGuid?: string }).guid ?? (raw as { messageGuid?: string }).messageGuid
      return { success: true, messageId: guid != null ? String(guid) : tempGuid, rawResponse: raw }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg, retryable: this.isRetryableError(msg) }
    }
  }

  /** Reaction / tapback on a message (BlueBubbles extension). */
  async sendTapback(chatGuid: string, messageGuid: string, reactionType: string): Promise<SendResult> {
    const url = new URL('/api/v1/message/react', this.serverUrl)
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatGuid,
          selectedMessageGuid: messageGuid,
          reactionType,
          password: this.password,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const raw = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { success: false, error: res.statusText, rawResponse: raw, retryable: res.status >= 500 }
      }
      return { success: true, rawResponse: raw }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg, retryable: this.isRetryableError(msg) }
    }
  }

  /** Mark chat read (BlueBubbles extension). */
  async sendReadReceipt(chatGuid: string): Promise<SendResult> {
    const url = new URL('/api/v1/chat/read', this.serverUrl)
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatGuid, password: this.password }),
        signal: AbortSignal.timeout(30_000),
      })
      const raw = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { success: false, error: res.statusText, rawResponse: raw }
      }
      return { success: true, rawResponse: raw }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg, retryable: this.isRetryableError(msg) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm' }
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
