/**
 * Discord bot adapter (discord.js).
 *
 * Handles DMs, guild channels, and threads; optional embeds for image URLs;
 * message edits for streaming. Ported from hermes-agent gateway/platforms/discord.py.
 *
 * Requires: discord.js (npm install discord.js)
 */

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, SessionSource } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let DiscordLib: any
try {
  DiscordLib = require('discord.js')
} catch {
  /* optional dependency */
}

export class DiscordAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 2000

  private client: any = null
  private botUserId: string | null = null

  constructor(config: PlatformConfig) {
    super(config, Platform.DISCORD)
  }

  async connect(): Promise<boolean> {
    if (!DiscordLib) {
      console.error('[discord] discord.js not installed. Run: npm install discord.js')
      this.setFatalError('missing_dep', 'discord.js not installed', false)
      return false
    }

    const token = this.config.token ?? process.env.DISCORD_BOT_TOKEN
    if (!token) {
      this.setFatalError('no_token', 'Discord bot token not set', false)
      return false
    }

    const {
      Client,
      GatewayIntentBits,
      Partials,
      ChannelType,
      EmbedBuilder,
    } = DiscordLib

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      })

      this.client.on('ready', (c: any) => {
        this.botUserId = c.user?.id ?? null
        console.log(`[discord] Logged in as ${c.user?.tag}`)
      })

      this.client.on('messageCreate', async (message: any) => {
        try {
          await this.onDiscordMessage(message, ChannelType)
        } catch (e) {
          console.error('[discord] messageCreate error:', e)
        }
      })

      await this.client.login(token)
      this.markConnected()
      return true
    } catch (err) {
      console.error('[discord] connect failed:', err)
      const msg = String(err)
      if (msg.includes('TOKEN_INVALID') || msg.includes('401')) {
        this.setFatalError('invalid_token', 'Invalid Discord bot token', false)
      } else {
        this.setFatalError('connect_error', msg, true)
      }
      return false
    }
  }

  private async onDiscordMessage(message: any, ChannelType: any): Promise<void> {
    if (!message.author || message.author.bot) return
    if (message.system) return

    const ch = message.channel
    const channelId = ch.id as string

    let chatType: SessionSource['chatType'] = 'channel'
    let threadId: string | undefined
    if (ch.type === ChannelType.DM || ch.type === ChannelType.GroupDM) {
      chatType = 'dm'
    } else if (ch.isThread?.()) {
      chatType = 'thread'
      threadId = channelId
    }

    const text = (message.content ?? '').trim()
    const attachments = [...(message.attachments?.values?.() ?? [])] as Array<{ url: string; contentType?: string | null }>
    const mediaUrls: string[] = attachments.map(a => a.url).filter(Boolean)
    const mediaTypes: string[] = attachments.map(a => a.contentType ?? 'application/octet-stream')

    let body = text
    let msgType = MessageType.TEXT
    if (attachments.length && !body) {
      const img = attachments.find(a => (a.contentType ?? '').startsWith('image/'))
      if (img) {
        msgType = MessageType.PHOTO
        body = img.url
      } else {
        msgType = MessageType.DOCUMENT
        body = attachments.map(a => a.url).join('\n')
      }
    }

    const source: SessionSource = {
      platform: Platform.DISCORD,
      chatId: channelId,
      chatName: ch.name ?? channelId,
      chatType,
      userId: message.author.id,
      userName: message.author.username,
      threadId,
    }

    const ev = createMessageEvent(body, source)
    ev.messageType = msgType
    ev.messageId = message.id
    ev.mediaUrls = mediaUrls
    ev.mediaTypes = mediaTypes
    if (message.reference?.messageId) {
      ev.replyToMessageId = message.reference.messageId as string
    }

    await this.handleMessage(ev)
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.destroy()
      } catch {}
      this.client = null
    }
    this.botUserId = null
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' }
    if (!DiscordLib) return { success: false, error: 'discord.js not available' }

    try {
      const channel = await this.client.channels.fetch(chatId)
      if (!channel || !channel.isTextBased?.()) {
        return { success: false, error: 'Channel not found or not text-based' }
      }

      const [images, plain] = BasePlatformAdapter.extractImages(content)
      const textBody = plain.trim() ? plain : ''
      const chunks = textBody ? this.truncateMessage(textBody, this.MAX_MESSAGE_LENGTH) : []

      const { EmbedBuilder } = DiscordLib
      const embeds =
        images.length > 0
          ? images.map(([url, alt]) =>
              new EmbedBuilder().setImage(url).setDescription(alt || '\u200b'),
            )
          : []

      const threadId = metadata?.thread_id as string | undefined
      const opts: Record<string, unknown> = {}
      if (replyTo) {
        opts.messageReference = { messageId: replyTo, failIfNotExists: false }
      }
      if (threadId && channel.isThread?.() === false) {
        const t = await this.client.channels.fetch(threadId).catch(() => null)
        if (t?.isThread?.()) {
          return this.send(t.id, content, replyTo, { ...metadata, thread_id: undefined })
        }
      }

      let lastId: string | undefined
      if (chunks.length === 0 && embeds.length > 0) {
        const sent = await channel.send({ ...opts, embeds })
        lastId = sent.id
      } else if (chunks.length === 0) {
        return { success: true, messageId: lastId }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const payload: any = { ...opts, content: chunks[i] }
          if (i === 0 && embeds.length) payload.embeds = embeds
          const sent = await channel.send(payload)
          lastId = sent.id
        }
      }

      return { success: true, messageId: lastId }
    } catch (e) {
      const err = String(e)
      return {
        success: false,
        error: err,
        retryable: this.isRetryableError(err),
      }
    }
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' }
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (!channel || !channel.isTextBased?.()) {
        return { success: false, error: 'Invalid channel' }
      }
      const msg = await channel.messages.fetch(messageId)
      const [images, plain] = BasePlatformAdapter.extractImages(content)
      const { EmbedBuilder } = DiscordLib
      const embeds =
        images.length > 0
          ? images.map(([url, alt]) =>
              new EmbedBuilder().setImage(url).setDescription(alt || '\u200b'),
            )
          : []
      await msg.edit({
        content: plain.slice(0, this.MAX_MESSAGE_LENGTH) || null,
        embeds: embeds.length ? embeds : [],
      })
      return { success: true, messageId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    if (!this.client) return { name: chatId, type: 'channel' }
    try {
      const ch = await this.client.channels.fetch(chatId)
      if (!ch) return { name: chatId, type: 'channel' }

      if (ch.isDMBased?.()) {
        return { name: ch.recipient?.username ?? chatId, type: 'dm' }
      }
      if (ch.isThread?.()) {
        return { name: ch.name ?? 'thread', type: 'channel', isThread: true, parentId: ch.parentId }
      }
      return { name: 'name' in ch && ch.name ? ch.name : chatId, type: 'channel' }
    } catch {
      return { name: chatId, type: 'channel' }
    }
  }
}
