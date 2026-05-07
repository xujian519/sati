/**
 * WhatsApp adapter — Node bridge subprocess + HTTP polling.
 *
 * Expects a local bridge exposing:
 * - GET  /messages — new inbound messages (JSON)
 * - POST /send — { chatId, message }
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const DEFAULT_BRIDGE_PORT = 3100
const POLL_MS = 2000

function extra(config: PlatformConfig, key: string): unknown {
  return config.extra?.[key]
}

function bridgeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export class WhatsAppAdapter extends BasePlatformAdapter {
  private bridgePort: number
  private bridgePath: string
  private child: ChildProcess | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollAbort = new AbortController()
  private seenIds = new Set<string>()

  constructor(config: PlatformConfig) {
    super(config, Platform.WHATSAPP)
    const p = Number(extra(config, 'bridgePort') ?? DEFAULT_BRIDGE_PORT)
    this.bridgePort = Number.isFinite(p) && p > 0 ? Math.floor(p) : DEFAULT_BRIDGE_PORT
    this.bridgePath = String(extra(config, 'bridgePath') ?? '').trim()
  }

  async connect(): Promise<boolean> {
    if (!this.bridgePath) {
      this.setFatalError('whatsapp_no_bridge', 'config.extra.bridgePath is required', false)
      return false
    }

    try {
      this.pollAbort = new AbortController()
      this.seenIds.clear()

      this.child = spawn(process.execPath, [this.bridgePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BRIDGE_PORT: String(this.bridgePort) },
      })
      this.child.stderr?.on('data', (d: Buffer) =>
        console.error('[whatsapp][bridge]', d.toString().trimEnd()),
      )
      this.child.on('error', err => console.error('[whatsapp] bridge spawn error:', err))
      this.child.on('exit', (code, sig) => {
        if (this.isConnected) {
          this.setFatalError(
            'whatsapp_bridge_exit',
            `Bridge exited (code=${code}, signal=${sig ?? 'none'})`,
            true,
          )
          void this.notifyFatalError()
        }
      })

      // Wait until /messages responds (bridge up)
      const ok = await this.waitForBridgeReady(15_000)
      if (!ok) {
        await this.cleanupChild()
        this.setFatalError('whatsapp_bridge_timeout', 'Bridge HTTP did not become ready', true)
        return false
      }

      this.markConnected()
      this.pollTimer = setInterval(() => void this.pollOnce(), POLL_MS)
      void this.pollOnce()
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.setFatalError('whatsapp_connect', msg, true)
      await this.cleanupChild()
      return false
    }
  }

  private async waitForBridgeReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${bridgeBaseUrl(this.bridgePort)}/messages`, {
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok || res.status === 404) return true
      } catch {
        // still starting
      }
      await new Promise(r => setTimeout(r, 400))
    }
    return false
  }

  private async pollOnce(): Promise<void> {
    if (!this.isConnected) return
    const url = `${bridgeBaseUrl(this.bridgePort)}/messages`
    try {
      const res = await fetch(url, { signal: this.pollAbort.signal })
      if (!res.ok) {
        console.warn(`[whatsapp] poll ${res.status} ${res.statusText}`)
        return
      }
      const data = (await res.json()) as unknown
      const list = this.normalizeMessages(data)
      for (const m of list) {
        if (this.seenIds.has(m.id)) continue
        this.seenIds.add(m.id)
        const source = {
          platform: Platform.WHATSAPP,
          chatId: m.chatId,
          chatName: m.chatName,
          chatType: m.isGroup ? ('group' as const) : ('dm' as const),
          userId: m.fromId,
          userName: m.fromName,
          threadId: m.threadId,
        }
        const base = createMessageEvent(m.text, source)
        const event = {
          ...base,
          messageId: m.id,
          messageType: m.messageType ?? MessageType.TEXT,
          mediaUrls: m.mediaUrls ?? [],
          mediaTypes: m.mediaTypes ?? [],
          replyToMessageId: m.replyToId,
        }
        void this.handleMessage(event)
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      console.error('[whatsapp] poll error:', e)
    }
  }

  private normalizeMessages(data: unknown): Array<{
    id: string
    chatId: string
    text: string
    chatName?: string
    fromId?: string
    fromName?: string
    isGroup?: boolean
    threadId?: string
    messageType?: MessageType
    mediaUrls?: string[]
    mediaTypes?: string[]
    replyToId?: string
  }> {
    const out: ReturnType<WhatsAppAdapter['normalizeMessages']> = []
    let raw: unknown[] = []
    if (Array.isArray(data)) raw = data
    else if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>
      if (Array.isArray(o.messages)) raw = o.messages
      else if (Array.isArray(o.data)) raw = o.data
    }
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const id = String(o.id ?? o.key ?? o.messageId ?? '').trim()
      const chatId = String(o.chatId ?? o.chat_id ?? o.from ?? '').trim()
      const text = String(o.text ?? o.body ?? o.content ?? '').trim()
      if (!id || !chatId) continue
      out.push({
        id,
        chatId,
        text: text || '[non-text]',
        chatName: o.chatName != null ? String(o.chatName) : undefined,
        fromId: o.fromId != null ? String(o.fromId) : o.from != null ? String(o.from) : undefined,
        fromName: o.fromName != null ? String(o.fromName) : undefined,
        isGroup: Boolean(o.isGroup ?? o.group),
        threadId: o.threadId != null ? String(o.threadId) : undefined,
        replyToId: o.replyToId != null ? String(o.replyToId) : undefined,
      })
    }
    return out
  }

  async disconnect(): Promise<void> {
    this.pollAbort.abort()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    await this.cleanupChild()
    this.markDisconnected()
  }

  private async cleanupChild(): Promise<void> {
    if (!this.child) return
    const proc = this.child
    this.child = null
    try {
      proc.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          resolve()
        }, 5000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    } catch {
      /* ignore */
    }
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const url = `${bridgeBaseUrl(this.bridgePort)}/send`
    try {
      const body: Record<string, unknown> = { chatId, message: this.formatMessage(content) }
      if (replyTo) body.replyTo = replyTo
      if (metadata) body.metadata = metadata
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const raw = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = (raw as { error?: string }).error ?? res.statusText
        return { success: false, error: err, rawResponse: raw, retryable: res.status >= 500 }
      }
      const mid = (raw as { messageId?: string; id?: string }).messageId ?? (raw as { id?: string }).id
      return { success: true, messageId: mid != null ? String(mid) : undefined, rawResponse: raw }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg, retryable: this.isRetryableError(msg) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm' }
  }
}
