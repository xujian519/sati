/**
 * Home Assistant adapter — WebSocket API.
 *
 * Config: token = HASS_TOKEN, extra.url = HASS_URL (http(s)://host:8123).
 * Auth with access_token; subscribe_events state_changed for entities under
 * extra.watchPrefixes (default conversation.).
 * Send: call_service persistent_notification.create.
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

function httpToWs(base: string): string {
  const u = new URL(base.startsWith('http') ? base : `http://${base}`)
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = u.pathname.replace(/\/$/, '')
  return `${proto}//${u.host}${path}/api/websocket`
}

export class HomeAssistantAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 25_000

  private url = ''
  private token = ''
  private ws: any = null
  private idCounter = 1
  private pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private closed = false
  private watchPrefixes: string[] = ['conversation.']
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authSettle: ((ok: boolean) => void) | null = null
  /** True after first successful auth_ok — enables reconnect loop on close. */
  private wsSessionReady = false

  constructor(config: PlatformConfig) {
    super(config, Platform.HOMEASSISTANT)
  }

  async connect(): Promise<boolean> {
    this.token =
      this.config.token || process.env.HASS_TOKEN || (this.config.apiKey as string) || ''
    this.url =
      (this.config.extra.url as string) || process.env.HASS_URL || 'http://127.0.0.1:8123'

    const prefixes = this.config.extra.watchPrefixes as string[] | undefined
    if (prefixes?.length) this.watchPrefixes = prefixes

    if (!this.token) {
      this.setFatalError('no_token', 'HASS_TOKEN / config.token not set', false)
      return false
    }

    if (!WebSocketImpl) {
      this.setFatalError('missing_ws', 'WebSocket unavailable', false)
      return false
    }

    this.closed = false
    this.wsSessionReady = false

    const authOk = await new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      const t = setTimeout(() => finish(false), 20_000)
      this.authSettle = ok => {
        clearTimeout(t)
        finish(ok)
      }
      this.openSocket()
    })
    this.authSettle = null

    if (!authOk) {
      console.error('[homeassistant] WebSocket auth failed or timed out')
      this.setFatalError('auth_failed', 'Home Assistant WebSocket auth failed', false)
      return false
    }

    this.markConnected()
    console.log(`[homeassistant] WebSocket ${httpToWs(this.url)}`)
    return true
  }

  private openSocket(): void {
    const wsUrl = httpToWs(this.url)
    try {
      const ws = new WebSocketImpl(wsUrl)
      this.ws = ws

      const onMessage = (data: string | Buffer) => {
        void this.onRawMessage(String(data))
      }
      const onClose = () => {
        this.ws = null
        this.authSettle?.(false)
        if (this.wsSessionReady && !this.closed && this._running) {
          this.reconnectTimer = setTimeout(() => this.openSocket(), 5000)
        }
      }
      const onError = (e: unknown) => console.error('[homeassistant] ws error:', e)

      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('message', (ev: MessageEvent) => onMessage(ev.data as string))
        ws.addEventListener('close', onClose)
        ws.addEventListener('error', onError as EventListener)
      } else {
        ws.on('message', onMessage)
        ws.on('close', onClose)
        ws.on('error', onError)
      }
    } catch (e) {
      console.error('[homeassistant] connect failed:', e)
      this.authSettle?.(false)
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return
    this.ws.send(JSON.stringify(obj))
  }

  private nextId(): number {
    return this.idCounter++
  }

  private async onRawMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const type = msg.type as string | undefined

    if (type === 'auth_required') {
      this.sendJson({ type: 'auth', access_token: this.token })
      return
    }

    if (type === 'auth_ok') {
      const sid = this.nextId()
      this.sendJson({
        id: sid,
        type: 'subscribe_events',
        event_type: 'state_changed',
      })
      this.wsSessionReady = true
      this.authSettle?.(true)
      this.authSettle = null
      return
    }

    if (type === 'auth_invalid') {
      this.authSettle?.(false)
      this.authSettle = null
      this.setFatalError('auth_invalid', String(msg.message ?? 'invalid token'), false)
      return
    }

    if (type === 'result') {
      const id = msg.id as number | undefined
      if (id !== undefined) {
        const cb = this.pending.get(id)
        if (cb) {
          this.pending.delete(id)
          cb(msg)
        }
      }
      return
    }

    if (type === 'event') {
      await this.handleHaEvent(msg)
    }
  }

  private async handleHaEvent(msg: Record<string, unknown>): Promise<void> {
    const ev = msg.event as Record<string, unknown> | undefined
    if (!ev) return

    const eventType = ev.event_type as string | undefined
    const data = ev.data as Record<string, unknown> | undefined

    if (eventType !== 'state_changed') return

    const ent = data?.entity_id as string | undefined
    if (!ent || !this.watchPrefixes.some(p => ent.startsWith(p))) return

    const newState = (data?.new_state as Record<string, unknown>)?.state
    const oldState = (data?.old_state as Record<string, unknown>)?.state
    if (newState === oldState) return
    const text = typeof newState === 'string' ? newState : JSON.stringify(newState)

    await this.emitInbound(ent, text, data)
  }

  private async emitInbound(
    chatId: string,
    text: string,
    extra: Record<string, unknown> | undefined,
  ): Promise<void> {
    const source = {
      platform: Platform.HOMEASSISTANT,
      chatId,
      chatName: chatId,
      chatType: 'channel' as const,
    }
    const ev = createMessageEvent(text, source)
    ev.messageType = MessageType.TEXT
    ev.internal = false
    if (extra) ev.source.chatTopic = JSON.stringify(extra).slice(0, 500)
    await this.handleMessage(ev)
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.wsSessionReady = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.pending.clear()
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
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.ws || this.ws.readyState !== 1) {
      return { success: false, error: 'Not connected' }
    }

    const title =
      (metadata?.title as string) ||
      (this.config.extra.notificationTitle as string) ||
      `Gateway · ${chatId}`

    const id = this.nextId()
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        resolve({ success: false, error: 'HA call_service timeout', retryable: true })
      }, 30_000)

      this.pending.set(id, result => {
        clearTimeout(t)
        const success = result.success === true
        if (!success) {
          resolve({
            success: false,
            error: JSON.stringify(result.error ?? result),
            retryable: false,
          })
        } else {
          resolve({ success: true, rawResponse: result.result })
        }
      })

      this.sendJson({
        id,
        type: 'call_service',
        domain: 'persistent_notification',
        service: 'create',
        service_data: {
          title,
          message: content,
          notification_id: `gw_${Date.now()}`,
        },
      })
    })
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'channel', platform: 'homeassistant' }
  }
}
