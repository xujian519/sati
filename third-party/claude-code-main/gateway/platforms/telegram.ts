/**
 * Telegram bot adapter using grammY.
 *
 * Supports:
 * - Long polling (default) and webhook modes
 * - Text, photo, video, audio, voice, document, sticker messages
 * - Forum topics (thread_id)
 * - MarkdownV2 formatting
 * - Message editing for streaming
 * - Typing indicators
 *
 * Ported from hermes-agent gateway/platforms/telegram.py.
 * Requires: grammy (npm install grammy)
 */

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, MessageEvent } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let Bot: any
let GrammyError: any
let InputFile: any

try {
  const grammy = require('grammy')
  Bot = grammy.Bot
  GrammyError = grammy.GrammyError
  InputFile = grammy.InputFile
} catch {
  // grammy not installed — will fail at connect()
}

export function checkTelegramRequirements(): boolean {
  return Bot !== undefined
}

const MAX_MESSAGE_LENGTH = 4096
const MAX_CAPTION_LENGTH = 1024

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function utf16Length(s: string): number {
  let len = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    len += code > 0xffff ? 2 : 1
  }
  return len
}

export class TelegramAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

  private bot: any = null
  private webhookMode = false
  private replyToMode: string

  constructor(config: PlatformConfig) {
    super(config, Platform.TELEGRAM)
    this.replyToMode = config.replyToMode ?? 'first'
  }

  async connect(): Promise<boolean> {
    if (!Bot) {
      console.error('[telegram] grammy not installed. Run: npm install grammy')
      this.setFatalError('missing_dep', 'grammy not installed', false)
      return false
    }

    const token = this.config.token
    if (!token) {
      this.setFatalError('no_token', 'TELEGRAM_BOT_TOKEN not set', false)
      return false
    }

    try {
      this.bot = new Bot(token)

      // Register message handlers
      this.bot.on('message:text', (ctx: any) => this.onTextMessage(ctx))
      this.bot.on('message:photo', (ctx: any) => this.onPhotoMessage(ctx))
      this.bot.on('message:voice', (ctx: any) => this.onVoiceMessage(ctx))
      this.bot.on('message:audio', (ctx: any) => this.onAudioMessage(ctx))
      this.bot.on('message:video', (ctx: any) => this.onVideoMessage(ctx))
      this.bot.on('message:document', (ctx: any) => this.onDocumentMessage(ctx))
      this.bot.on('message:sticker', (ctx: any) => this.onStickerMessage(ctx))

      this.bot.catch((err: any) => {
        console.error('[telegram] Bot error:', err)
      })

      // Check webhook vs polling mode
      const webhookUrl = this.config.extra.webhookUrl as string | undefined
      if (webhookUrl) {
        this.webhookMode = true
        await this.bot.api.setWebhook(webhookUrl)
        console.log(`[telegram] Webhook mode: ${webhookUrl}`)
      } else {
        // Long polling
        await this.bot.api.deleteWebhook()
        this.bot.start({
          drop_pending_updates: false,
          onStart: () => {
            console.log('[telegram] Polling started')
          },
        })
      }

      this.markConnected()
      const me = await this.bot.api.getMe()
      console.log(`[telegram] Connected as @${me.username}`)
      return true
    } catch (err) {
      console.error('[telegram] Connection failed:', err)
      const msg = String(err)
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        this.setFatalError('invalid_token', 'Invalid bot token', false)
      } else if (msg.includes('409') || msg.includes('Conflict')) {
        this.setFatalError('polling_conflict', 'Another instance is polling this bot', false)
      } else {
        this.setFatalError('connect_error', msg, true)
      }
      return false
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      try {
        await this.bot.stop()
      } catch {}
      this.bot = null
    }
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.bot) return { success: false, error: 'Not connected' }

    try {
      const opts: Record<string, unknown> = {}

      // Thread/topic support
      const threadId = metadata?.thread_id ?? metadata?.message_thread_id
      if (threadId) opts.message_thread_id = Number(threadId)

      // Reply threading
      if (replyTo) opts.reply_to_message_id = Number(replyTo)

      // Truncate to platform limit
      const chunks = this.truncateMessage(content, MAX_MESSAGE_LENGTH)

      let lastMessageId: string | undefined
      for (const chunk of chunks) {
        try {
          const msg = await this.bot.api.sendMessage(chatId, chunk, {
            ...opts,
            parse_mode: undefined, // Use plain text for reliability
          })
          lastMessageId = String(msg.message_id)
        } catch (err: any) {
          // Retry without parse_mode if markdown fails
          if (err?.description?.includes('parse')) {
            const msg = await this.bot.api.sendMessage(chatId, chunk, opts)
            lastMessageId = String(msg.message_id)
          } else {
            throw err
          }
        }
      }

      return { success: true, messageId: lastMessageId }
    } catch (err) {
      return this.handleSendError(err)
    }
  }

  async editMessage(
    chatId: string,
    messageId: string,
    content: string,
  ): Promise<SendResult> {
    if (!this.bot) return { success: false, error: 'Not connected' }

    try {
      // Truncate to fit
      if (utf16Length(content) > MAX_MESSAGE_LENGTH) {
        content = content.slice(0, MAX_MESSAGE_LENGTH - 10) + '...'
      }

      await this.bot.api.editMessageText(chatId, Number(messageId), content)
      return { success: true, messageId }
    } catch (err: any) {
      const errStr = String(err?.description ?? err)
      if (errStr.includes('message is not modified')) {
        return { success: true, messageId }
      }
      if (errStr.includes('Too Many Requests') || errStr.includes('retry after')) {
        return { success: false, error: `Flood control: ${errStr}`, retryable: true }
      }
      return { success: false, error: errStr }
    }
  }

  async sendTyping(chatId: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.bot) return
    try {
      const opts: Record<string, unknown> = { action: 'typing' }
      const threadId = metadata?.thread_id ?? metadata?.message_thread_id
      if (threadId) opts.message_thread_id = Number(threadId)
      await this.bot.api.sendChatAction(chatId, 'typing', opts)
    } catch {}
  }

  async sendImage(
    chatId: string,
    imageUrl: string,
    caption?: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.bot) return { success: false, error: 'Not connected' }
    try {
      const opts: Record<string, unknown> = {}
      if (caption) opts.caption = caption.slice(0, MAX_CAPTION_LENGTH)
      if (replyTo) opts.reply_to_message_id = Number(replyTo)
      const threadId = metadata?.thread_id
      if (threadId) opts.message_thread_id = Number(threadId)

      const msg = await this.bot.api.sendPhoto(chatId, imageUrl, opts)
      return { success: true, messageId: String(msg.message_id) }
    } catch (err) {
      return this.handleSendError(err)
    }
  }

  async sendAnimation(
    chatId: string,
    animationUrl: string,
    caption?: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.bot) return { success: false, error: 'Not connected' }
    try {
      const opts: Record<string, unknown> = {}
      if (caption) opts.caption = caption.slice(0, MAX_CAPTION_LENGTH)
      if (replyTo) opts.reply_to_message_id = Number(replyTo)
      const threadId = metadata?.thread_id
      if (threadId) opts.message_thread_id = Number(threadId)

      const msg = await this.bot.api.sendAnimation(chatId, animationUrl, opts)
      return { success: true, messageId: String(msg.message_id) }
    } catch (err) {
      return this.handleSendError(err)
    }
  }

  async sendDocument(
    chatId: string,
    documentPath: string,
    caption?: string,
    replyTo?: string,
  ): Promise<SendResult> {
    if (!this.bot || !InputFile) return { success: false, error: 'Not connected' }
    try {
      const opts: Record<string, unknown> = {}
      if (caption) opts.caption = caption.slice(0, MAX_CAPTION_LENGTH)
      if (replyTo) opts.reply_to_message_id = Number(replyTo)

      const msg = await this.bot.api.sendDocument(chatId, new InputFile(documentPath), opts)
      return { success: true, messageId: String(msg.message_id) }
    } catch (err) {
      return this.handleSendError(err)
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    if (!this.bot) return { name: chatId, type: 'dm' }
    try {
      const chat = await this.bot.api.getChat(chatId)
      let chatType: ChatInfo['type'] = 'dm'
      if (chat.type === 'group' || chat.type === 'supergroup') chatType = 'group'
      else if (chat.type === 'channel') chatType = 'channel'

      return {
        name: chat.title ?? chat.first_name ?? chatId,
        type: chatType,
      }
    } catch {
      return { name: chatId, type: 'dm' }
    }
  }

  // ─── Message handlers ───

  private async onTextMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    if (!msg?.text) return

    const source = this.buildSource(ctx)
    const event = createMessageEvent(msg.text, source)
    event.messageId = String(msg.message_id)

    if (msg.reply_to_message) {
      event.replyToMessageId = String(msg.reply_to_message.message_id)
      event.replyToText = msg.reply_to_message.text
    }

    await this.handleMessage(event)
  }

  private async onPhotoMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    if (!msg?.photo) return

    const source = this.buildSource(ctx)
    const photo = msg.photo[msg.photo.length - 1]
    const event = createMessageEvent(msg.caption ?? '', source)
    event.messageType = MessageType.PHOTO
    event.messageId = String(msg.message_id)

    try {
      const file = await ctx.api.getFile(photo.file_id)
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`
        event.mediaUrls.push(url)
        event.mediaTypes.push('image')
      }
    } catch {}

    await this.handleMessage(event)
  }

  private async onVoiceMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    const source = this.buildSource(ctx)
    const event = createMessageEvent(msg.caption ?? '[Voice message]', source)
    event.messageType = MessageType.VOICE
    event.messageId = String(msg.message_id)

    try {
      const file = await ctx.api.getFile(msg.voice.file_id)
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`
        event.mediaUrls.push(url)
        event.mediaTypes.push('audio')
      }
    } catch {}

    await this.handleMessage(event)
  }

  private async onAudioMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    const source = this.buildSource(ctx)
    const event = createMessageEvent(msg.caption ?? '[Audio]', source)
    event.messageType = MessageType.AUDIO
    event.messageId = String(msg.message_id)
    await this.handleMessage(event)
  }

  private async onVideoMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    const source = this.buildSource(ctx)
    const event = createMessageEvent(msg.caption ?? '[Video]', source)
    event.messageType = MessageType.VIDEO
    event.messageId = String(msg.message_id)
    await this.handleMessage(event)
  }

  private async onDocumentMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    const source = this.buildSource(ctx)
    const event = createMessageEvent(msg.caption ?? '[Document]', source)
    event.messageType = MessageType.DOCUMENT
    event.messageId = String(msg.message_id)

    try {
      const file = await ctx.api.getFile(msg.document.file_id)
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`
        event.mediaUrls.push(url)
        event.mediaTypes.push('document')
      }
    } catch {}

    await this.handleMessage(event)
  }

  private async onStickerMessage(ctx: any): Promise<void> {
    const msg = ctx.message
    const source = this.buildSource(ctx)
    const emoji = msg.sticker?.emoji ?? '🎯'
    const event = createMessageEvent(`[Sticker: ${emoji}]`, source)
    event.messageType = MessageType.STICKER
    event.messageId = String(msg.message_id)
    await this.handleMessage(event)
  }

  // ─── Helpers ───

  private buildSource(ctx: any): MessageEvent['source'] {
    const msg = ctx.message
    const chat = msg.chat
    const from = msg.from

    let chatType: 'dm' | 'group' | 'channel' = 'dm'
    if (chat.type === 'group' || chat.type === 'supergroup') chatType = 'group'
    else if (chat.type === 'channel') chatType = 'channel'

    return {
      platform: Platform.TELEGRAM,
      chatId: String(chat.id),
      chatName: chat.title ?? chat.first_name,
      chatType,
      userId: from ? String(from.id) : undefined,
      userName: from
        ? from.username ?? `${from.first_name ?? ''}${from.last_name ? ' ' + from.last_name : ''}`.trim()
        : undefined,
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    }
  }

  private handleSendError(err: unknown): SendResult {
    const errStr = String(err)
    if (errStr.includes('Too Many Requests') || errStr.includes('retry after')) {
      return { success: false, error: `Flood control: ${errStr}`, retryable: true }
    }
    if (errStr.includes('chat not found') || errStr.includes('bot was blocked')) {
      return { success: false, error: errStr }
    }
    console.error('[telegram] Send error:', err)
    return { success: false, error: errStr, retryable: true }
  }
}
