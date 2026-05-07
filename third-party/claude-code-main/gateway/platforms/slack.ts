/**
 * Slack bot adapter — @slack/bolt with Socket Mode.
 *
 * Requires SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...).
 * Threads, file uploads (metadata.filePath), chat.update for streaming edits.
 * Ported from hermes-agent gateway/platforms/slack.py.
 *
 * Requires: @slack/bolt (npm install @slack/bolt)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, SessionSource } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let BoltApp: any
try {
  BoltApp = require('@slack/bolt').App
} catch {
  /* optional */
}

export class SlackAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 39000

  private app: any = null
  private botUserId: string | null = null

  constructor(config: PlatformConfig) {
    super(config, Platform.SLACK)
  }

  async connect(): Promise<boolean> {
    if (!BoltApp) {
      console.error('[slack] @slack/bolt not installed. Run: npm install @slack/bolt')
      this.setFatalError('missing_dep', '@slack/bolt not installed', false)
      return false
    }

    const botToken = this.config.token ?? process.env.SLACK_BOT_TOKEN
    const appToken =
      (this.config.extra.app_token as string | undefined) ?? process.env.SLACK_APP_TOKEN

    if (!botToken) {
      this.setFatalError('no_token', 'SLACK_BOT_TOKEN not set', false)
      return false
    }
    if (!appToken) {
      this.setFatalError('no_app_token', 'SLACK_APP_TOKEN not set (required for Socket Mode)', false)
      return false
    }

    try {
      this.app = new BoltApp({
        token: botToken,
        appToken,
        socketMode: true,
      })

      this.app.event('message', async ({ event, client }: any) => {
        try {
          await this.onSlackMessage(event, client)
        } catch (e) {
          console.error('[slack] message handler error:', e)
        }
      })

      await this.app.start()
      const auth = await this.app.client.auth.test({ token: botToken })
      this.botUserId = auth.user_id as string
      this.markConnected()
      console.log(`[slack] Socket Mode connected as ${auth.user ?? auth.user_id}`)
      return true
    } catch (e) {
      console.error('[slack] connect failed:', e)
      this.setFatalError('connect_error', String(e), true)
      return false
    }
  }

  private async onSlackMessage(event: any, _client: any): Promise<void> {
    if (event.bot_id || event.subtype === 'bot_message') return
    if (event.subtype === 'message_changed' || event.subtype === 'message_deleted') return
    const uid = event.user
    if (uid && this.botUserId && uid === this.botUserId) return

    const channelId = event.channel as string
    const text = (event.text ?? '').replace(/<@[^>]+>/g, '').trim()
    const threadTs = (event.thread_ts as string | undefined) ?? undefined
    const ts = event.ts as string

    const isDm = event.channel_type === 'im' || channelId?.startsWith('D')
    const source: SessionSource = {
      platform: Platform.SLACK,
      chatId: channelId,
      chatName: channelId,
      chatType: isDm ? 'dm' : 'group',
      userId: uid,
      threadId: threadTs,
    }

    const mediaUrls: string[] = []
    const mediaTypes: string[] = []
    let msgType = MessageType.TEXT
    const files = (event.files as any[]) ?? []
    for (const f of files) {
      const url = f.url_private_download || f.url_private
      const mt = f.mimetype ?? ''
      if (url) {
        mediaUrls.push(url)
        mediaTypes.push(mt)
        if (mt.startsWith('image/')) msgType = MessageType.PHOTO
        else msgType = MessageType.DOCUMENT
      }
    }

    const ev = createMessageEvent(text, source)
    ev.messageId = ts
    ev.messageType = msgType
    ev.mediaUrls = mediaUrls
    ev.mediaTypes = mediaTypes
    if (threadTs && threadTs !== ts) ev.replyToMessageId = threadTs

    await this.handleMessage(ev)
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop()
      } catch {}
      this.app = null
    }
    this.botUserId = null
    this.markDisconnected()
  }

  private resolveThreadTs(replyTo?: string, metadata?: Record<string, unknown>): string | undefined {
    if (metadata?.thread_id) return String(metadata.thread_id)
    if (metadata?.thread_ts) return String(metadata.thread_ts)
    return replyTo
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.app) return { success: false, error: 'Not connected' }

    const filePath = metadata?.filePath as string | undefined
    if (filePath && fs.existsSync(filePath)) {
      try {
        const threadTs = this.resolveThreadTs(replyTo, metadata)
        const result = await this.app.client.filesUploadV2({
          channel_id: chatId,
          file: filePath,
          filename: path.basename(filePath),
          initial_comment: this.formatSlackMrkdwn(content) || undefined,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
        const files = (result as any).files as Array<{ id?: string }> | undefined
        const id = files?.[0]?.id
        return { success: true, messageId: id, rawResponse: result }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    try {
      const formatted = this.formatSlackMrkdwn(content)
      const chunks = this.truncateMessage(formatted, this.MAX_MESSAGE_LENGTH)
      const threadTs = this.resolveThreadTs(replyTo, metadata)
      let lastTs: string | undefined

      for (const chunk of chunks) {
        const res = await this.app.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          mrkdwn: true,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
        lastTs = res.ts as string
      }
      return { success: true, messageId: lastTs, rawResponse: lastTs }
    } catch (e) {
      const err = String(e)
      return { success: false, error: err, retryable: this.isRetryableError(err) }
    }
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
    if (!this.app) return { success: false, error: 'Not connected' }
    try {
      await this.app.client.chat.update({
        channel: chatId,
        ts: messageId,
        text: this.formatSlackMrkdwn(content),
        mrkdwn: true,
      })
      return { success: true, messageId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    if (!this.app) return { name: chatId, type: 'group' }
    try {
      const result = await this.app.client.conversations.info({ channel: chatId })
      const channel = result.channel as any
      const isDm = channel?.is_im
      return {
        name: channel?.name ?? chatId,
        type: isDm ? 'dm' : 'group',
      }
    } catch {
      return { name: chatId, type: 'group' }
    }
  }

  /** Minimal markdown → Slack mrkdwn (see hermes slack.py for full rules). */
  private formatSlackMrkdwn(content: string): string {
    if (!content) return content
    let t = content
    t = t.replace(/\*\*(.+?)\*\*/g, '*$1*')
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    return t
  }
}
