/**
 * Weixin (personal WeChat) adapter — iLink-style HTTP long-poll + send API.
 *
 * Inbound: GET {baseUrl}/getupdates?token=&account_id=&timeout=30
 * Outbound: POST {baseUrl}/sendmessage
 * CDN assets: AES-128-ECB decryption when extra.cdnAesKey is set.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const LONG_POLL_TIMEOUT_SEC = 30
const CONNECT_BACKOFF_MS = 3000

function env(k: string): string {
  return String(process.env[k] ?? '').trim()
}

function extra(config: PlatformConfig, key: string): unknown {
  return config.extra?.[key]
}

/** PKCS#7 unpad */
function unpad(buf: Buffer): Buffer {
  const n = buf[buf.length - 1]
  if (n <= 0 || n > 16) return buf
  return buf.subarray(0, buf.length - n)
}

export function decryptWeixinCdnBuffer(cipher: Buffer, aesKeyUtf8: string): Buffer {
  const key = createHash('md5').update(aesKeyUtf8, 'utf8').digest() // 16 bytes
  const decipher = createDecipheriv('aes-128-ecb', key, Buffer.alloc(0))
  decipher.setAutoPadding(false)
  const dec = Buffer.concat([decipher.update(cipher), decipher.final()])
  return unpad(dec)
}

export class WeixinAdapter extends BasePlatformAdapter {
  private readonly baseUrl: string
  private readonly accountId: string
  private readonly token: string
  private readonly cdnAesKey?: string

  private loopAbort = new AbortController()
  private pollPromise: Promise<void> | null = null
  /** Server-side update cursor / last msg id */
  private lastOffset = ''

  constructor(config: PlatformConfig) {
    super(config, Platform.WEIXIN)
    const ex = config.extra ?? {}
    this.baseUrl = String(ex.baseUrl ?? env('WEIXIN_BASE_URL')).replace(/\/+$/, '')
    this.accountId = String(ex.accountId ?? env('WEIXIN_ACCOUNT_ID'))
    this.token = String(config.token ?? env('WEIXIN_TOKEN'))
    const k = ex.cdnAesKey ?? ex.cdn_aes_key
    this.cdnAesKey = k != null && String(k).length > 0 ? String(k) : undefined
  }

  async connect(): Promise<boolean> {
    if (!this.baseUrl || !this.accountId || !this.token) {
      this.setFatalError(
        'weixin_config',
        'WEIXIN token, config.extra.baseUrl, and config.extra.accountId are required',
        false,
      )
      return false
    }
    this.loopAbort = new AbortController()
    this.lastOffset = ''
    this.pollPromise = this.longPollLoop()
    this.markConnected()
    return true
  }

  async disconnect(): Promise<void> {
    this.loopAbort.abort()
    try {
      await this.pollPromise
    } catch {
      /* ignore */
    }
    this.pollPromise = null
    this.markDisconnected()
  }

  private async longPollLoop(): Promise<void> {
    while (!this.loopAbort.signal.aborted) {
      try {
        const url = new URL('/getupdates', this.baseUrl)
        url.searchParams.set('token', this.token)
        url.searchParams.set('account_id', this.accountId)
        url.searchParams.set('timeout', String(LONG_POLL_TIMEOUT_SEC))
        if (this.lastOffset) url.searchParams.set('offset', this.lastOffset)

        const res = await fetch(url, {
          signal: this.loopAbort.signal,
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) {
          console.warn(`[weixin] getupdates HTTP ${res.status}`)
          await this.sleep(CONNECT_BACKOFF_MS)
          continue
        }
        const data = (await res.json()) as Record<string, unknown>
        if (typeof data.next_offset === 'string') this.lastOffset = data.next_offset
        else if (typeof data.offset === 'string') this.lastOffset = data.offset

        const updates = Array.isArray(data.updates)
          ? data.updates
          : Array.isArray(data.messages)
            ? data.messages
            : Array.isArray(data.result)
              ? data.result
              : []
        for (const u of updates) {
          await this.dispatchUpdate(u as Record<string, unknown>)
        }
      } catch (e) {
        if (this.loopAbort.signal.aborted) break
        console.error('[weixin] long-poll error:', e)
        await this.sleep(CONNECT_BACKOFF_MS)
      }
    }
  }

  private async dispatchUpdate(u: Record<string, unknown>): Promise<void> {
    const msgId = String(u.msg_id ?? u.message_id ?? u.id ?? '')
    const fromUser = String(u.from_user ?? u.from ?? u.user_id ?? '')
    const chatId = String(u.chat_id ?? u.to_chat ?? fromUser ?? 'unknown')
    const text = String(u.content ?? u.text ?? '')
    const msgType = String(u.msg_type ?? u.type ?? 'text')
    const contextToken =
      u.context_token != null
        ? String(u.context_token)
        : u.thread_id != null
          ? String(u.thread_id)
          : undefined

    let mediaUrls: string[] = []
    let mediaTypes: string[] = []
    let messageType = MessageType.TEXT
    let bodyText = text

    if (msgType === 'image' || msgType === 'photo') {
      messageType = MessageType.PHOTO
      const url = String(u.cdn_url ?? u.url ?? '')
      if (url) {
        mediaUrls = [await this.maybeDecryptCdnUrl(url)]
        mediaTypes = ['image/jpeg']
      }
      if (!bodyText) bodyText = '[image]'
    } else if (msgType === 'voice' || msgType === 'audio') {
      messageType = MessageType.VOICE
      const url = String(u.cdn_url ?? u.url ?? '')
      if (url) {
        mediaUrls = [await this.maybeDecryptCdnUrl(url)]
        mediaTypes = ['audio/mpeg']
      }
      if (!bodyText) bodyText = '[voice]'
    }

    const source = {
      platform: Platform.WEIXIN,
      chatId,
      chatName: u.chat_name != null ? String(u.chat_name) : undefined,
      chatType: (u.is_group ? 'group' : 'dm') as 'dm' | 'group',
      userId: fromUser || undefined,
      userName: u.user_name != null ? String(u.user_name) : undefined,
      threadId: contextToken,
    }

    const base = createMessageEvent(bodyText, source)
    const event = {
      ...base,
      messageId: msgId || undefined,
      messageType,
      mediaUrls,
      mediaTypes,
      replyToMessageId: u.reply_to != null ? String(u.reply_to) : undefined,
    }
    void this.handleMessage(event)
  }

  private async maybeDecryptCdnUrl(url: string): Promise<string> {
    if (!this.cdnAesKey || !url.startsWith('http')) return url
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) return url
      const buf = Buffer.from(await res.arrayBuffer())
      const plain = decryptWeixinCdnBuffer(buf, this.cdnAesKey)
      // Return as data URL for downstream consumers
      const b64 = plain.toString('base64')
      return `data:application/octet-stream;base64,${b64}`
    } catch (e) {
      console.error('[weixin] CDN decrypt failed, using original URL:', e)
      return url
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const url = new URL('/sendmessage', this.baseUrl)
    try {
      const contextToken = metadata?.context_token != null ? String(metadata.context_token) : undefined
      const body: Record<string, unknown> = {
        token: this.token,
        account_id: this.accountId,
        to_user: chatId,
        content: this.formatMessage(content),
        msg_type: 'text',
      }
      if (contextToken) body.context_token = contextToken

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const raw = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = (raw as { errmsg?: string; message?: string }).errmsg ??
          (raw as { message?: string }).message ?? res.statusText
        return { success: false, error: err, rawResponse: raw, retryable: res.status >= 500 }
      }
      const errcode = (raw as { errcode?: number }).errcode
      if (errcode != null && errcode !== 0) {
        return {
          success: false,
          error: String((raw as { errmsg?: string }).errmsg ?? 'errcode'),
          rawResponse: raw,
        }
      }
      const mid = (raw as { msg_id?: string; id?: string }).msg_id ?? (raw as { id?: string }).id
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
