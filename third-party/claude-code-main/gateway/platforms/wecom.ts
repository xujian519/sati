/**
 * WeCom (Enterprise WeChat) AI Bot adapter — WebSocket gateway at wss://openws.work.weixin.qq.com
 *
 * Protocol (from hermes-agent wecom.py): aibot_subscribe, aibot_msg_callback, aibot_send_msg, ping.
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, MessageEvent } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const require = createRequire(import.meta.url)

let WebSocket: typeof import('ws') | null = null
try {
  WebSocket = require('ws')
} catch {
  WebSocket = null
}

const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com'
const APP_CMD_SUBSCRIBE = 'aibot_subscribe'
const APP_CMD_CALLBACK = 'aibot_msg_callback'
const APP_CMD_SEND = 'aibot_send_msg'
const APP_CMD_RESPONSE = 'aibot_respond_msg'
const APP_CMD_PING = 'ping'
const CALLBACK_COMMANDS = new Set([APP_CMD_CALLBACK, 'aibot_callback'])
const NON_RESPONSE_COMMANDS = new Set([...CALLBACK_COMMANDS, 'aibot_event_callback'])
const MAX_MESSAGE_LENGTH = 4000
const CONNECT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000

export function checkWeComRequirements(): boolean {
  return WebSocket !== null
}

function env(k: string): string {
  return String(process.env[k] ?? '').trim()
}

export class WeComAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

  private readonly botId: string
  private readonly botSecret: string
  private readonly wsUrl: string

  private ws: InstanceType<NonNullable<typeof WebSocket>> | null = null
  private pending = new Map<string, (p: Record<string, unknown>) => void>()
  private listenStopped = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** messageId -> inbound websocket req_id for reply correlation */
  private replyReqIds = new Map<string, string>()

  constructor(config: PlatformConfig) {
    super(config, Platform.WECOM)
    const ex = config.extra ?? {}
    this.botId = String(ex.bot_id ?? ex.botId ?? env('WECOM_BOT_ID'))
    this.botSecret = String(ex.botSecret ?? ex.secret ?? env('WECOM_SECRET'))
    this.wsUrl = String(
      ex.websocket_url ?? ex.websocketUrl ?? env('WECOM_WEBSOCKET_URL') ?? DEFAULT_WS_URL,
    ).trim() || DEFAULT_WS_URL
  }

  async connect(): Promise<boolean> {
    if (!WebSocket) {
      this.setFatalError('wecom_missing_ws', 'ws package not available', true)
      return false
    }
    if (!this.botId || !this.botSecret) {
      this.setFatalError('wecom_credentials', 'WeCom bot_id and secret are required in config.extra', false)
      return false
    }

    try {
      await this.cleanupWs()
      this.ws = new WebSocket(this.wsUrl) as InstanceType<NonNullable<typeof WebSocket>>

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WeCom WebSocket connect timeout')), CONNECT_TIMEOUT_MS)
        this.ws!.once('open', () => {
          clearTimeout(t)
          resolve()
        })
        this.ws!.once('error', err => {
          clearTimeout(t)
          reject(err)
        })
      })

      this.listenStopped = false
      this.ws.on('message', (data: WebSocket.RawData) => void this.onSocketData(data.toString()))
      this.ws.on('close', () => {
        if (this.isConnected && !this.listenStopped) {
          this.setFatalError('wecom_ws_closed', 'WeCom WebSocket closed', true)
        }
      })
      this.ws.on('error', err => console.error('[wecom] WebSocket error:', err))

      const reqId = this.newReqId('subscribe')
      await this.sendJson({
        cmd: APP_CMD_SUBSCRIBE,
        headers: { req_id: reqId },
        body: { bot_id: this.botId, secret: this.botSecret },
      })

      const auth = await this.waitForReq(reqId, CONNECT_TIMEOUT_MS)
      const body = (auth as { body?: { errcode?: number; errmsg?: string } }).body
      const errcode = body?.errcode ?? (auth as { errcode?: number }).errcode
      if (errcode != null && errcode !== 0) {
        const errmsg = body?.errmsg ?? (auth as { errmsg?: string }).errmsg ?? 'auth failed'
        throw new Error(`${errmsg} (errcode=${errcode})`)
      }

      this.heartbeatTimer = setInterval(() => {
        void this.sendPingFrame()
      }, 30_000)

      this.markConnected()
      return true
    } catch (e) {
      this.setFatalError('wecom_connect', String(e), true)
      await this.cleanupWs()
      return false
    }
  }

  async disconnect(): Promise<void> {
    this.listenStopped = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.pending.clear()
    this.replyReqIds.clear()
    await this.cleanupWs()
    this.markDisconnected()
  }

  private async cleanupWs(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${randomUUID().replace(/-/g, '')}`
  }

  private payloadReqId(payload: Record<string, unknown>): string {
    const h = payload.headers as Record<string, unknown> | undefined
    return String(h?.req_id ?? '')
  }

  private async sendJson(payload: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket!.OPEN) {
      throw new Error('WeCom websocket is not connected')
    }
    this.ws.send(JSON.stringify(payload))
  }

  private async waitForReq(reqId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('Timeout waiting for WeCom response'))
      }, timeoutMs)
      this.pending.set(reqId, p => {
        clearTimeout(t)
        this.pending.delete(reqId)
        resolve(p)
      })
    })
  }

  private async onSocketData(raw: string): Promise<void> {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const reqId = this.payloadReqId(payload)
    const cmd = String(payload.cmd ?? '')

    if (reqId && this.pending.has(reqId) && !NON_RESPONSE_COMMANDS.has(cmd)) {
      const fn = this.pending.get(reqId)
      if (fn) fn(payload)
      return
    }

    if (CALLBACK_COMMANDS.has(cmd)) {
      await this.onBotCallback(payload)
    }
  }

  private async onBotCallback(payload: Record<string, unknown>): Promise<void> {
    const body = payload.body as Record<string, unknown> | undefined
    if (!body) return

    const msgId = String(body.msgid ?? this.payloadReqId(payload))
    const inboundReq = this.payloadReqId(payload)
    if (msgId && inboundReq) this.replyReqIds.set(msgId, inboundReq)

    const sender = (body.from as Record<string, unknown> | undefined) ?? {}
    const senderId = String(sender.userid ?? '').trim()
    const chatId = String(body.chatid ?? senderId).trim()
    if (!chatId) return

    const isGroup = String(body.chattype ?? '').toLowerCase() === 'group'
    const { text, replyText } = this.extractText(body)
    const { mediaUrls, mediaTypes } = this.extractMediaHints(body)

    let finalText = text
    if (!finalText && replyText && !mediaUrls.length) finalText = replyText
    if (!finalText && !mediaUrls.length) return

    const mt = this.deriveMessageType(body, mediaTypes)

    const event = createMessageEvent(finalText, {
      platform: Platform.WECOM,
      chatId,
      chatType: isGroup ? 'group' : 'dm',
      userId: senderId || undefined,
      userName: senderId || undefined,
    })
    event.messageId = msgId
    event.messageType = mt
    event.mediaUrls = mediaUrls
    event.mediaTypes = mediaTypes
    if (replyText && finalText) {
      event.replyToMessageId = `quote:${msgId}`
      event.replyToText = replyText
    }

    await this.handleMessage(event)
  }

  private extractText(body: Record<string, unknown>): { text: string; replyText?: string } {
    const parts: string[] = []
    const msgtype = String(body.msgtype ?? '').toLowerCase()

    if (msgtype === 'mixed') {
      const mixed = (body.mixed as Record<string, unknown> | undefined) ?? {}
      const items = (mixed.msg_item as unknown[]) ?? []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const it = item as Record<string, unknown>
        if (String(it.msgtype ?? '').toLowerCase() === 'text') {
          const tb = (it.text as Record<string, unknown> | undefined) ?? {}
          const c = String(tb.content ?? '').trim()
          if (c) parts.push(c)
        }
      }
    } else {
      const tb = (body.text as Record<string, unknown> | undefined) ?? {}
      const c = String(tb.content ?? '').trim()
      if (c) parts.push(c)
    }

    const quote = (body.quote as Record<string, unknown> | undefined) ?? {}
    let replyText: string | undefined
    if (String(quote.msgtype ?? '').toLowerCase() === 'text') {
      const qt = (quote.text as Record<string, unknown> | undefined) ?? {}
      replyText = String(qt.content ?? '').trim() || undefined
    }

    return { text: parts.join('\n').trim(), replyText }
  }

  private extractMediaHints(body: Record<string, unknown>): { mediaUrls: string[]; mediaTypes: string[] } {
    const urls: string[] = []
    const types: string[] = []
    const msgtype = String(body.msgtype ?? '').toLowerCase()

    const push = (kind: string, ref: Record<string, unknown>) => {
      const u = String(ref.url ?? '').trim()
      if (u) {
        urls.push(u)
        types.push(kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
      } else if (ref.base64) {
        urls.push(`inline:base64:${kind}`)
        types.push(kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
      }
    }

    if (msgtype !== 'mixed' && body.image && typeof body.image === 'object') {
      push('image', body.image as Record<string, unknown>)
    }
    if (msgtype === 'file' && body.file && typeof body.file === 'object') {
      push('file', body.file as Record<string, unknown>)
    }

    return { mediaUrls: urls, mediaTypes: types }
  }

  private deriveMessageType(body: Record<string, unknown>, mediaTypes: string[]): MessageType {
    if (mediaTypes.some(m => m.startsWith('image/'))) return MessageType.PHOTO
    if (String(body.msgtype ?? '').toLowerCase() === 'voice') return MessageType.VOICE
    if (mediaTypes.some(m => m.startsWith('application/'))) return MessageType.DOCUMENT
    return MessageType.TEXT
  }

  private replyReqFor(replyTo?: string): string | undefined {
    const n = String(replyTo ?? '').trim()
    if (!n || n.startsWith('quote:')) return undefined
    return this.replyReqIds.get(n)
  }

  private async sendRequest(cmd: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = this.newReqId(cmd)
    const promise = this.waitForReq(reqId, REQUEST_TIMEOUT_MS)
    await this.sendJson({ cmd, headers: { req_id: reqId }, body })
    return promise
  }

  private async sendReplyRequest(
    replyReqId: string,
    body: Record<string, unknown>,
    cmd = APP_CMD_RESPONSE,
  ): Promise<Record<string, unknown>> {
    const rid = String(replyReqId).trim()
    if (!rid) throw new Error('reply_req_id is required')
    const promise = this.waitForReq(rid, REQUEST_TIMEOUT_MS)
    await this.sendJson({ cmd, headers: { req_id: rid }, body })
    return promise
  }

  /** Application ping — fire-and-forget (matches Python; no response wait). */
  private async sendPingFrame(): Promise<void> {
    try {
      await this.sendJson({
        cmd: APP_CMD_PING,
        headers: { req_id: this.newReqId('ping') },
        body: {},
      })
    } catch {}
  }

  private responseError(res: Record<string, unknown>): string | undefined {
    const body = res.body as Record<string, unknown> | undefined
    const errcode = body?.errcode ?? (res as { errcode?: unknown }).errcode
    if (errcode === 0 || errcode == null) return undefined
    const errmsg = String(body?.errmsg ?? (res as { errmsg?: unknown }).errmsg ?? 'error')
    return `WeCom errcode ${String(errcode)}: ${errmsg}`
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    _metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    void _metadata
    if (!chatId) return { success: false, error: 'chat_id is required' }
    if (!this.ws || this.ws.readyState !== 1) {
      return { success: false, error: 'Not connected', retryable: true }
    }

    const slice = content.slice(0, MAX_MESSAGE_LENGTH)
    const replyReq = this.replyReqFor(replyTo)

    try {
      let response: Record<string, unknown>
      if (replyReq) {
        response = await this.sendReplyRequest(replyReq, {
          msgtype: 'stream',
          stream: {
            id: this.newReqId('stream'),
            finish: true,
            content: slice,
          },
        })
      } else {
        response = await this.sendRequest(APP_CMD_SEND, {
          chatid: chatId,
          msgtype: 'markdown',
          markdown: { content: slice },
        })
      }

      const err = this.responseError(response)
      if (err) return { success: false, error: err, rawResponse: response }

      return {
        success: true,
        messageId: this.payloadReqId(response) || randomUUID().slice(0, 12),
        rawResponse: response,
      }
    } catch (e) {
      return { success: false, error: String(e), retryable: true }
    }
  }

  async sendTyping(_chatId: string, _metadata?: Record<string, unknown>): Promise<void> {
    void _chatId
    void _metadata
    // WeCom AI Bot gateway does not document a typing indicator command; no-op.
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    const lower = chatId.toLowerCase()
    const type: ChatInfo['type'] = lower.includes('group') || lower.startsWith('wr') ? 'group' : 'dm'
    return { name: chatId, type }
  }
}
