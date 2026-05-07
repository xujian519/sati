/**
 * Mattermost adapter — WebSocket events + REST send/edit.
 *
 * Config: extra.url (MATTERMOST_URL), token (MATTERMOST_TOKEN).
 * WS: wss://{host}/api/v4/websocket?token=...
 * REST: POST /api/v4/posts, PUT /api/v4/posts/{id}
 */

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let WebSocketImpl: any
try {
  const wsMod = require('ws')
  WebSocketImpl = wsMod.WebSocket ?? wsMod
} catch {
  WebSocketImpl = globalThis.WebSocket
}

function toWsBase(url: string): { wsBase: string; origin: string } {
  const u = new URL(url.startsWith('http') ? url : `https://${url}`)
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = u.pathname.replace(/\/$/, '')
  const wsBase = `${proto}//${u.host}${path}`
  const origin = `${u.protocol === 'https:' ? 'https:' : 'http:'}//${u.host}`
  return { wsBase, origin }
}

export class MattermostAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 16383

  private apiBase = ''
  private token = ''
  private ws: InstanceType<typeof WebSocket> | null = null
  private botUserId: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(config: PlatformConfig) {
    super(config, Platform.MATTERMOST)
  }

  async connect(): Promise<boolean> {
    const rawUrl =
      (this.config.extra.url as string) || process.env.MATTERMOST_URL || ''
    this.token =
      this.config.token || process.env.MATTERMOST_TOKEN || (this.config.apiKey as string) || ''

    if (!rawUrl || !this.token) {
      this.setFatalError('no_config', 'MATTERMOST_URL and MATTERMOST_TOKEN required', false)
      return false
    }

    if (!WebSocketImpl) {
      this.setFatalError('missing_ws', 'WebSocket unavailable', false)
      return false
    }

    const { wsBase, origin } = toWsBase(rawUrl)
    this.apiBase = rawUrl.replace(/\/$/, '')

    try {
      const me = await this.rest('GET', '/users/me')
      this.botUserId = (me as { id?: string }).id ?? null
    } catch (e) {
      console.error('[mattermost] token check failed:', e)
      this.setFatalError('auth_failed', String(e), false)
      return false
    }

    this.closed = false
    this.openWebSocket(wsBase, origin)
    this.markConnected()
    console.log(`[mattermost] WebSocket + REST: ${this.apiBase}`)
    return true
  }

  private openWebSocket(wsBase: string, origin: string): void {
    const q = `token=${encodeURIComponent(this.token)}`
    const url = `${wsBase}/api/v4/websocket?${q}`

    try {
      const ws = new WebSocketImpl(url, { headers: { Origin: origin } })
      this.ws = ws

      const onMsg = (data: string | Buffer) => void this.onWsMessage(String(data))
      const onErr = (e: unknown) => console.error('[mattermost] ws error:', e)
      const onClose = () => {
        this.ws = null
        if (!this.closed && this._running) {
          this.reconnectTimer = setTimeout(() => this.openWebSocket(wsBase, origin), 4000)
        }
      }

      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('message', (ev: MessageEvent) =>
          onMsg((ev as { data?: string | Buffer }).data ?? ''),
        )
        ws.addEventListener('error', onErr as EventListener)
        ws.addEventListener('close', onClose)
      } else {
        ws.on('message', onMsg)
        ws.on('error', onErr)
        ws.on('close', onClose)
      }
    } catch (e) {
      console.error('[mattermost] ws connect failed:', e)
      this.setFatalError('ws_error', String(e), true)
    }
  }

  private async onWsMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const event = msg.event as string | undefined
    if (event !== 'posted') return

    const dataStr = (msg.data as Record<string, unknown> | undefined)?.post as string | undefined
    if (!dataStr) return

    let post: Record<string, unknown>
    try {
      post = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      return
    }

    const userId = post.user_id as string | undefined
    if (userId && this.botUserId && userId === this.botUserId) return

    const message = (post.message as string) ?? ''
    const channelId = post.channel_id as string | undefined
    const id = post.id as string | undefined
    const rootId = (post.root_id as string) || undefined

    if (!channelId || !message.trim()) return

    const props = post.props as Record<string, unknown> | undefined
    if (props?.from_webhook === 'true' || props?.from_bot === 'true') return

    const source = {
      platform: Platform.MATTERMOST,
      chatId: channelId,
      chatName: channelId,
      chatType: 'channel' as const,
      userId,
      threadId: rootId || undefined,
    }

    const ev = createMessageEvent(message.replace(/\r\n/g, '\n'), source)
    ev.messageId = id
    ev.messageType = MessageType.TEXT
    if (rootId) ev.replyToMessageId = rootId

    await this.handleMessage(ev)
  }

  private async rest(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
    }
    if (!text) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this._running) return { success: false, error: 'Not connected' }

    const rootId =
      (metadata?.root_id as string) || (metadata?.thread_id as string) || replyTo || ''

    try {
      const post = (await this.rest('POST', '/posts', {
        channel_id: chatId,
        message: content,
        root_id: rootId || undefined,
      })) as { id?: string }
      return { success: true, messageId: post.id }
    } catch (e) {
      const err = String(e)
      return { success: false, error: err, retryable: this.isRetryableError(err) }
    }
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
    if (!this._running) return { success: false, error: 'Not connected' }
    try {
      await this.rest('PUT', `/posts/${encodeURIComponent(messageId)}`, {
        id: messageId,
        channel_id: chatId,
        message: content,
      })
      return { success: true, messageId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    try {
      const ch = (await this.rest('GET', `/channels/${encodeURIComponent(chatId)}`)) as {
        display_name?: string
        name?: string
        type?: string
      }
      const type = ch.type === 'D' ? 'dm' : ch.type === 'G' ? 'group' : 'channel'
      return {
        name: ch.display_name || ch.name || chatId,
        type,
      }
    } catch {
      return { name: chatId, type: 'channel' }
    }
  }
}
