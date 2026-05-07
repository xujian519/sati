/**
 * Signal adapter — signal-cli REST API + SSE inbound stream.
 *
 * Config: extra.httpUrl (SIGNAL_HTTP_URL), extra.account (SIGNAL_ACCOUNT phone).
 * Inbound: GET {httpUrl}/v1/receive/{account} (SSE / streamed JSON).
 * Outbound: POST {httpUrl}/v2/send with message, number, recipients, optional base64_attachments.
 *
 * Editing outbound messages is not supported (Signal limitation).
 */

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function extractTextFromEnvelope(raw: Record<string, unknown>): {
  text: string
  sourceNumber?: string
  sourceUuid?: string
  messageId?: string
  chatId?: string
} {
  const envelope = raw.envelope as Record<string, unknown> | undefined
  if (!envelope) return { text: '' }

  const sync = envelope.syncMessage as Record<string, unknown> | undefined
  const sent = sync?.sentMessage as Record<string, unknown> | undefined
  const dm = envelope.dataMessage as Record<string, unknown> | undefined
  const msg =
    (typeof sent?.message === 'string' && sent.message) ||
    (typeof dm?.message === 'string' && dm.message) ||
    ''

  const source =
    (typeof envelope.source === 'string' && envelope.source) ||
    (typeof envelope.sourceNumber === 'string' && envelope.sourceNumber) ||
    undefined
  const sourceUuid =
    typeof envelope.sourceUuid === 'string' ? envelope.sourceUuid : undefined

  const ts =
    (typeof dm?.timestamp === 'number' && String(dm.timestamp)) ||
    (typeof sent?.timestamp === 'number' && String(sent.timestamp)) ||
    undefined

  const groupId =
    (dm?.groupInfo as Record<string, unknown> | undefined)?.groupId ??
    (sent?.groupInfo as Record<string, unknown> | undefined)?.groupId
  const chatId =
    typeof groupId === 'string' ? `group:${groupId}` : source ? `dm:${source}` : undefined

  return { text: msg, sourceNumber: source, sourceUuid, messageId: ts, chatId }
}

export class SignalAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 2000

  private httpUrl = ''
  private account = ''
  private abort: AbortController | null = null
  private receivePromise: Promise<void> | null = null

  constructor(config: PlatformConfig) {
    super(config, Platform.SIGNAL)
  }

  async connect(): Promise<boolean> {
    this.httpUrl = normalizeBaseUrl(
      (this.config.extra.httpUrl as string) ||
        process.env.SIGNAL_HTTP_URL ||
        'http://127.0.0.1:8080',
    )
    this.account =
      (this.config.extra.account as string) || process.env.SIGNAL_ACCOUNT || ''

    if (!this.account) {
      this.setFatalError('no_account', 'SIGNAL_ACCOUNT / config.extra.account not set', false)
      return false
    }

    this.abort = new AbortController()
    this.receivePromise = this.runReceiveLoop(this.abort.signal)
    this.markConnected()
    console.log(`[signal] SSE receive: ${this.httpUrl}/v1/receive/${encodeURIComponent(this.account)}`)
    return true
  }

  private async runReceiveLoop(signal: AbortSignal): Promise<void> {
    const url = `${this.httpUrl}/v1/receive/${encodeURIComponent(this.account)}`
    let carry = ''

    while (!signal.aborted && this._running) {
      try {
        const res = await fetch(url, {
          signal,
          headers: { Accept: 'text/event-stream, application/json, */*' },
        })
        if (!res.ok) {
          console.error(`[signal] receive HTTP ${res.status}: ${await res.text().catch(() => '')}`)
          await this.sleepBackoff(signal)
          continue
        }
        if (!res.body) {
          await this.sleepBackoff(signal)
          continue
        }

        const reader = res.body.getReader()
        const dec = new TextDecoder()
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          carry += dec.decode(value, { stream: true })
          const lines = carry.split(/\r?\n/)
          carry = lines.pop() ?? ''
          for (const line of lines) {
            await this.parseLine(line)
          }
        }
      } catch (e) {
        if (signal.aborted) break
        console.error('[signal] receive stream error:', e)
        await this.sleepBackoff(signal)
      }
    }
  }

  private async parseLine(line: string): Promise<void> {
    let payload = line.trim()
    if (!payload) return
    if (payload.startsWith('data:')) payload = payload.slice(5).trim()
    if (payload === '[DONE]' || payload === ':ok') return

    let data: Record<string, unknown>
    try {
      data = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }

    const { text, sourceNumber, sourceUuid, messageId, chatId } = extractTextFromEnvelope(data)
    if (!text.trim()) return

    const sessionChatId = chatId ?? (sourceNumber ? `dm:${sourceNumber}` : this.account)
    const source = {
      platform: Platform.SIGNAL,
      chatId: sessionChatId,
      chatName: sourceNumber ?? sessionChatId,
      chatType: sessionChatId.startsWith('group:') ? 'group' : 'dm',
      userId: sourceNumber,
      userIdAlt: sourceUuid,
      chatIdAlt: sourceUuid,
    }

    const ev = createMessageEvent(text, source)
    ev.messageId = messageId
    ev.messageType = MessageType.TEXT
    await this.handleMessage(ev)
  }

  private async sleepBackoff(signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      const t = setTimeout(() => resolve(), 3000)
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
    this.abort?.abort()
    this.abort = null
    if (this.receivePromise) {
      try {
        await this.receivePromise
      } catch {}
      this.receivePromise = null
    }
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this._running) return { success: false, error: 'Not connected' }

    const recipient =
      (metadata?.recipient as string) ||
      (metadata?.number as string) ||
      chatId.replace(/^(dm:|group:)/, '')

    const body: Record<string, unknown> = {
      message: content,
      number: this.account,
      recipients: [recipient],
    }

    const b64 = metadata?.base64_attachments as string[] | undefined
    if (b64?.length) body.base64_attachments = b64

    try {
      const res = await fetch(`${this.httpUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const raw = await res.text()
      if (!res.ok) {
        return {
          success: false,
          error: `HTTP ${res.status}: ${raw.slice(0, 500)}`,
          retryable: res.status >= 500,
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }
      return { success: true, rawResponse: parsed }
    } catch (e) {
      const err = String(e)
      return { success: false, error: err, retryable: this.isRetryableError(err) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return {
      name: chatId,
      type: chatId.startsWith('group:') ? 'group' : 'dm',
      signal: true,
    }
  }
}
