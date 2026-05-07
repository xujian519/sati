/**
 * SMS adapter — Twilio outbound + HTTP webhook for inbound.
 *
 * Config: extra.accountSid, extra.phoneNumber (From), config.apiKey = auth token.
 * Optional dep: twilio
 */

import { createHmac, timingSafeEqual } from 'crypto'

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let twilioFactory: any
try {
  twilioFactory = require('twilio')
} catch {
  /* optional */
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PATH = '/sms/incoming'

export class SmsAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 1600

  private accountSid = ''
  private authToken = ''
  private fromNumber = ''
  private client: any = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private publicUrl = ''

  constructor(config: PlatformConfig) {
    super(config, Platform.SMS)
  }

  async connect(): Promise<boolean> {
    if (!twilioFactory) {
      console.error('[sms] Install: npm install twilio')
      this.setFatalError('missing_dep', 'twilio not installed', false)
      return false
    }

    this.accountSid =
      (this.config.extra.accountSid as string) || process.env.TWILIO_ACCOUNT_SID || ''
    this.authToken =
      this.config.apiKey || process.env.TWILIO_AUTH_TOKEN || (this.config.token as string) || ''
    this.fromNumber =
      (this.config.extra.phoneNumber as string) || process.env.TWILIO_PHONE_NUMBER || ''

    const host = (this.config.extra.webhookHost as string) || DEFAULT_HOST
    const port = Number(this.config.extra.webhookPort ?? process.env.TWILIO_WEBHOOK_PORT ?? 8790)
    const path = (this.config.extra.webhookPath as string) || DEFAULT_PATH
    this.publicUrl = (this.config.extra.publicUrl as string) || ''

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      this.setFatalError(
        'no_config',
        'Need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (apiKey), TWILIO_PHONE_NUMBER',
        false,
      )
      return false
    }

    try {
      this.client = twilioFactory(this.accountSid, this.authToken)
    } catch (e) {
      this.setFatalError('twilio_init', String(e), false)
      return false
    }

    try {
      this.server = Bun.serve({
        hostname: host,
        port,
        fetch: (req) => this.handleHttp(req, path),
      })
      this.markConnected()
      console.log(
        `[sms] Twilio webhook http://${host}:${port}${path}` +
          (this.publicUrl ? ` (configure Twilio URL: ${this.publicUrl}${path})` : ''),
      )
      return true
    } catch (e) {
      console.error('[sms] HTTP server failed:', e)
      this.setFatalError('http_start', String(e), true)
      return false
    }
  }

  private async handleHttp(req: Request, path: string): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname !== path || req.method !== 'POST') {
      return new Response('Not Found', { status: 404 })
    }

    let params: Record<string, string>
    try {
      const ct = req.headers.get('content-type') || ''
      if (ct.includes('application/x-www-form-urlencoded')) {
        const body = await req.text()
        params = Object.fromEntries(new URLSearchParams(body))
      } else if (ct.includes('application/json')) {
        params = (await req.json()) as Record<string, string>
      } else {
        const body = await req.text()
        params = Object.fromEntries(new URLSearchParams(body))
      }
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    const sig = req.headers.get('X-Twilio-Signature') || ''
    const fullUrl = this.publicUrl
      ? `${this.publicUrl.replace(/\/$/, '')}${path}`
      : `http://${this.server?.hostname ?? DEFAULT_HOST}:${this.server?.port ?? ''}${path}`

    if (this.authToken && sig) {
      if (!this.validateTwilioSignature(fullUrl, params, sig)) {
        console.warn('[sms] Invalid Twilio signature')
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const body = params.Body ?? ''
    const from = params.From ?? ''
    if (!from || !body.trim()) {
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
        headers: { 'Content-Type': 'text/xml' },
      })
    }

    const source = {
      platform: Platform.SMS,
      chatId: from,
      chatName: from,
      chatType: 'dm' as const,
      userId: from,
    }

    const ev = createMessageEvent(body, source)
    ev.messageId = params.MessageSid
    ev.messageType = MessageType.TEXT

    void this.handleMessage(ev).catch(e => console.error('[sms] handleMessage:', e))

    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      headers: { 'Content-Type': 'text/xml' },
    })
  }

  /** Twilio request validation (public URL must match configured webhook URL). */
  private validateTwilioSignature(
    url: string,
    params: Record<string, string>,
    signature: string,
  ): boolean {
    const keys = Object.keys(params).sort()
    let data = url
    for (const k of keys) {
      data += k + params[k]
    }
    const hmac = createHmac('sha1', this.authToken).update(data).digest('base64')
    try {
      const a = Buffer.from(hmac)
      const b = Buffer.from(signature)
      return a.length === b.length && timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
    this.client = null
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    _metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' }

    try {
      const msg = await this.client.messages.create({
        body: content,
        from: this.fromNumber,
        to: chatId,
      })
      return { success: true, messageId: msg.sid as string, rawResponse: msg }
    } catch (e: any) {
      const err = String(e?.message ?? e)
      return {
        success: false,
        error: err,
        retryable: /5\d\d|timeout|ECONNRESET/i.test(err),
      }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm', medium: 'sms' }
  }
}
