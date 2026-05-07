/**
 * DingTalk chatbot adapter — Stream mode WebSocket via dingtalk-stream SDK.
 * Outbound replies use the per-message session webhook URL (see hermes-agent dingtalk.py).
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const require = createRequire(import.meta.url)

let DingStream: {
  DWClient: new (opts: { clientId: string; clientSecret: string; debug?: boolean }) => DingTalkClient
  EventAck: { SUCCESS: string; LATER: string }
  TOPIC_ROBOT: string
} | null = null

try {
  DingStream = require('dingtalk-stream')
} catch {
  DingStream = null
}

type DingTalkClient = {
  registerAllEventListener: (
    cb: (msg: DingDownstream) => { status: string; message?: string },
  ) => DingTalkClient
  connect: () => Promise<void>
  disconnect: () => void
}

interface DingDownstream {
  headers: { topic?: string; messageId?: string; [k: string]: unknown }
  data: string
}

const MAX_MESSAGE_LENGTH = 20000
const WEBHOOK_RE = /^https:\/\/api\.dingtalk\.com\//
const SESSION_WEBHOOKS_MAX = 500

export function checkDingTalkRequirements(): boolean {
  return DingStream !== null
}

function env(k: string): string {
  return String(process.env[k] ?? '').trim()
}

export class DingTalkAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

  private readonly clientId: string
  private readonly clientSecret: string
  private client: DingTalkClient | null = null
  private readonly sessionWebhooks = new Map<string, string>()
  private readonly seenIds = new Set<string>()

  constructor(config: PlatformConfig) {
    super(config, Platform.DINGTALK)
    const ex = config.extra ?? {}
    this.clientId = String(ex.client_id ?? ex.clientId ?? env('DINGTALK_CLIENT_ID'))
    this.clientSecret = String(ex.client_secret ?? ex.clientSecret ?? env('DINGTALK_CLIENT_SECRET'))
  }

  async connect(): Promise<boolean> {
    if (!DingStream) {
      console.error('[dingtalk] dingtalk-stream not installed. Run: npm install dingtalk-stream')
      this.setFatalError('dingtalk_missing_sdk', 'dingtalk-stream package required', true)
      return false
    }
    if (!this.clientId || !this.clientSecret) {
      this.setFatalError('dingtalk_credentials', 'DingTalk clientId and clientSecret required in config.extra', false)
      return false
    }

    try {
      this.client = new DingStream.DWClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        debug: Boolean(process.env.DINGTALK_STREAM_DEBUG),
      })

      this.client.registerAllEventListener(msg => {
        void this.onDownstream(msg).catch(e => console.error('[dingtalk] onDownstream:', e))
        return { status: DingStream!.EventAck.SUCCESS }
      })

      await this.client.connect()
      this.markConnected()
      return true
    } catch (e) {
      this.setFatalError('dingtalk_connect', String(e), true)
      return false
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.client?.disconnect()
    } catch {}
    this.client = null
    this.sessionWebhooks.clear()
    this.seenIds.clear()
    this.markDisconnected()
  }

  private async onDownstream(msg: DingDownstream): Promise<void> {
    const topic = String(msg.headers?.topic ?? '')
    if (topic && DingStream && topic !== DingStream.TOPIC_ROBOT) return

    let data: Record<string, unknown>
    try {
      data = JSON.parse(msg.data) as Record<string, unknown>
    } catch {
      return
    }

    const msgId = String(data.msgId ?? data.messageId ?? msg.headers?.messageId ?? randomUUID())
    if (this.seenIds.has(msgId)) return
    this.seenIds.add(msgId)
    if (this.seenIds.size > 2000) {
      const first = this.seenIds.values().next().value
      if (first) this.seenIds.delete(first as string)
    }

    const text = this.extractText(data)
    if (!text.trim()) return

    const conversationId = String(data.conversationId ?? '')
    const senderId = String(data.senderId ?? '')
    const chatId = conversationId || senderId
    if (!chatId) return

    const convType = String(data.conversationType ?? '1')
    const isGroup = convType === '2'

    const webhook = String(data.sessionWebhook ?? '')
    if (webhook && WEBHOOK_RE.test(webhook)) {
      this.rememberWebhook(chatId, webhook)
    }

    const event = createMessageEvent(text, {
      platform: Platform.DINGTALK,
      chatId,
      chatName: String(data.conversationTitle ?? '') || undefined,
      chatType: isGroup ? 'group' : 'dm',
      userId: senderId || undefined,
      userName: String(data.senderNick ?? senderId) || undefined,
      userIdAlt: String(data.senderStaffId ?? '') || undefined,
    })
    event.messageId = msgId
    event.messageType = MessageType.TEXT

    const ts = Number(data.createAt)
    if (!Number.isNaN(ts)) event.timestamp = new Date(ts)

    await this.handleMessage(event)
  }

  private rememberWebhook(chatId: string, url: string): void {
    if (this.sessionWebhooks.size >= SESSION_WEBHOOKS_MAX) {
      const k = this.sessionWebhooks.keys().next().value
      if (k) this.sessionWebhooks.delete(k)
    }
    this.sessionWebhooks.set(chatId, url)
  }

  private extractText(data: Record<string, unknown>): string {
    const t = data.text
    if (t && typeof t === 'object' && 'content' in (t as object)) {
      return String((t as { content?: string }).content ?? '').trim()
    }
    if (typeof t === 'string') return t.trim()

    const rich = data.richText ?? data.rich_text
    if (Array.isArray(rich)) {
      const parts = rich
        .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
        .map(x => String(x.text ?? ''))
        .filter(Boolean)
      return parts.join(' ').trim()
    }
    return ''
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    void _replyTo
    const sessionWebhook = String(metadata?.session_webhook ?? metadata?.sessionWebhook ?? '') ||
      this.sessionWebhooks.get(chatId)
    if (!sessionWebhook) {
      return {
        success: false,
        error: 'No session_webhook available. Replies must follow an inbound Stream message for this chat.',
      }
    }
    if (!WEBHOOK_RE.test(sessionWebhook)) {
      return { success: false, error: 'session_webhook failed origin check' }
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: 'Reply',
        text: content.slice(0, MAX_MESSAGE_LENGTH),
      },
    }

    try {
      const res = await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const bodyText = await res.text()
      if (res.ok) {
        return { success: true, messageId: randomUUID().slice(0, 12), rawResponse: bodyText }
      }
      return { success: false, error: `HTTP ${res.status}: ${bodyText.slice(0, 200)}` }
    } catch (e) {
      return { success: false, error: String(e), retryable: true }
    }
  }

  async sendTyping(_chatId: string, _metadata?: Record<string, unknown>): Promise<void> {
    void _chatId
    void _metadata
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    const type: ChatInfo['type'] = chatId.toLowerCase().includes('group') ? 'group' : 'dm'
    return { name: chatId, type }
  }
}
