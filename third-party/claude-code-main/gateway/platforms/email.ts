/**
 * Email adapter — IMAP (imapflow) inbound polling + SMTP (nodemailer) send.
 *
 * Optional deps: imapflow, nodemailer
 * Config extra: address, password, imapHost, smtpHost, imapPort, smtpPort,
 *   pollIntervalMs, imapTls, smtpTls
 */

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let ImapFlow: any
let nodemailer: any
try {
  ImapFlow = require('imapflow').ImapFlow
} catch {
  /* optional */
}
try {
  nodemailer = require('nodemailer')
} catch {
  /* optional */
}

export class EmailAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 100_000

  private pollTimer: ReturnType<typeof setInterval> | null = null
  private seenUids = new Set<number>()
  private imapClient: any = null
  private transporter: any = null
  private pollIntervalMs = 45_000
  private ownAddress = ''

  constructor(config: PlatformConfig) {
    super(config, Platform.EMAIL)
  }

  private get extra() {
    return this.config.extra
  }

  async connect(): Promise<boolean> {
    if (!ImapFlow || !nodemailer) {
      console.error('[email] Install: npm install imapflow nodemailer')
      this.setFatalError('missing_dep', 'imapflow and/or nodemailer not installed', false)
      return false
    }

    this.ownAddress = String(this.extra.address || process.env.EMAIL_ADDRESS || '')
    const password = String(this.extra.password || process.env.EMAIL_PASSWORD || '')
    const imapHost = String(this.extra.imapHost || process.env.IMAP_HOST || '')
    const smtpHost = String(this.extra.smtpHost || process.env.SMTP_HOST || '')
    const imapPort = Number(this.extra.imapPort ?? process.env.IMAP_PORT ?? 993)
    const smtpPort = Number(this.extra.smtpPort ?? process.env.SMTP_PORT ?? 587)
    this.pollIntervalMs = Number(this.extra.pollIntervalMs ?? 45_000)

    if (!this.ownAddress || !password || !imapHost || !smtpHost) {
      this.setFatalError(
        'no_config',
        'Need extra.address, password, imapHost, smtpHost (or env equivalents)',
        false,
      )
      return false
    }

    const imapTls = this.extra.imapTls !== false
    const smtpTls = this.extra.smtpTls !== false

    try {
      this.imapClient = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapTls,
        auth: { user: this.ownAddress, pass: password },
        logger: false,
      })

      await this.imapClient.connect()
      await this.imapClient.mailboxOpen('INBOX')

      try {
        const st = await this.imapClient.status('INBOX', { uidNext: true })
        const next = st.uidNext ?? 1
        if (next > 1) {
          const from = Math.max(1, next - 300)
          for await (const msg of this.imapClient.fetch(`${from}:${next - 1}`, { uid: true })) {
            this.seenUids.add(msg.uid as number)
          }
        }
      } catch (e) {
        console.warn('[email] UID priming skipped:', e)
      }

      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        requireTLS: smtpTls && smtpPort !== 465,
        auth: { user: this.ownAddress, pass: password },
      })
      await this.transporter.verify()

      await this.pollOnce()
      this.pollTimer = setInterval(() => {
        void this.pollOnce()
      }, this.pollIntervalMs)

      this.markConnected()
      console.log(`[email] IMAP+SMTP connected (${imapHost} / ${smtpHost})`)
      return true
    } catch (e) {
      console.error('[email] connect failed:', e)
      this.setFatalError('connect_error', String(e), true)
      await this.cleanupImap()
      return false
    }
  }

  private async cleanupImap(): Promise<void> {
    if (this.imapClient) {
      try {
        await this.imapClient.logout()
      } catch {}
      this.imapClient = null
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.imapClient || !this._running) return
    const lock = await this.imapClient.getMailboxLock('INBOX')
    try {
      for await (const msg of this.imapClient.fetch(
        { unseen: true },
        { envelope: true, source: true, uid: true },
      )) {
        const uid = msg.uid as number
        if (this.seenUids.has(uid)) continue
        this.seenUids.add(uid)

        const env = msg.envelope as Record<string, unknown> | undefined
        const from = env?.from as Array<{ address?: string }> | undefined
        const replyAddr = from?.[0]?.address ?? 'unknown'

        let text = ''
        try {
          const raw =
            msg.source instanceof Buffer
              ? msg.source.toString('utf8')
              : String((msg as { source?: Buffer }).source ?? '')
          text = this.extractPlainText(raw)
        } catch {
          text = '[Could not decode message body]'
        }

        if (!text.trim()) continue

        const source = {
          platform: Platform.EMAIL,
          chatId: replyAddr,
          chatName: replyAddr,
          chatType: 'dm' as const,
          userId: replyAddr,
        }

        const ev = createMessageEvent(text, source)
        ev.messageId = String(uid)
        ev.messageType = MessageType.TEXT
        await this.handleMessage(ev)
      }
    } catch (e) {
      console.error('[email] poll error:', e)
    } finally {
      lock.release()
    }
  }

  /** Minimal MIME parser: prefer text/plain part */
  private extractPlainText(raw: string): string {
    if (!raw.includes('Content-Type:')) {
      return raw.trim()
    }
    const plain = raw.match(/Content-Type:\s*text\/plain[^\r\n]*[\r\n]+([\s\S]*?)(?=--[a-f0-9]{8,}|Content-Type:|$)/i)
    if (plain?.[1]) {
      let body = plain[1].replace(/^\r?\n/, '')
      const te = body.match(/^Content-Transfer-Encoding:\s*quoted-printable\r?\n([\s\S]*)/i)
      if (te) {
        body = te[1].replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        )
      }
      return body.trim()
    }
    return raw.slice(0, 8000).trim()
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.transporter = null
    await this.cleanupImap()
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    _metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.transporter) return { success: false, error: 'Not connected' }

    try {
      const info = await this.transporter.sendMail({
        from: this.ownAddress,
        to: chatId,
        subject: (this.extra.defaultSubject as string) || 'Message',
        text: content,
      })
      return { success: true, messageId: info.messageId as string | undefined, rawResponse: info }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm', medium: 'email' }
  }
}
