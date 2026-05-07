/**
 * Base platform adapter interface.
 *
 * All platform adapters inherit from this and implement the required methods:
 * - connect() / disconnect()
 * - send()
 * - getChatInfo()
 *
 * Ported from hermes-agent gateway/platforms/base.py.
 */

import type {
  MessageEvent,
  MessageHandler,
  SendResult,
  ChatInfo,
  PlatformConfig,
} from '../types'
import { Platform, MessageType } from '../types'

const RETRYABLE_ERROR_PATTERNS = [
  'connecterror',
  'connectionerror',
  'connectionreset',
  'connectionrefused',
  'connecttimeout',
  'network',
  'broken pipe',
  'remotedisconnected',
  'eoferror',
]

export abstract class BasePlatformAdapter {
  readonly config: PlatformConfig
  readonly platform: Platform

  /** Max message length in characters (platform-specific, subclasses override) */
  MAX_MESSAGE_LENGTH = 4096

  /** Whether the platform supports editing messages for progressive streaming.
   *  Platforms that don't (e.g. Feishu text) should set this to false. */
  supportsStreaming = true

  protected _messageHandler: MessageHandler | null = null
  protected _running = false
  protected _fatalErrorCode: string | null = null
  protected _fatalErrorMessage: string | null = null
  protected _fatalErrorRetryable = true
  protected _fatalErrorHandler: ((adapter: BasePlatformAdapter) => Promise<void>) | null = null

  protected _activeSessions = new Map<string, AbortController>()
  protected _pendingMessages = new Map<string, MessageEvent>()
  protected _typingPaused = new Set<string>()

  constructor(config: PlatformConfig, platform: Platform) {
    this.config = config
    this.platform = platform
  }

  // ─── Properties ───

  get name(): string {
    return this.platform.charAt(0).toUpperCase() + this.platform.slice(1)
  }

  get isConnected(): boolean {
    return this._running
  }

  get hasFatalError(): boolean {
    return this._fatalErrorMessage !== null
  }

  get fatalErrorMessage(): string | null {
    return this._fatalErrorMessage
  }

  get fatalErrorCode(): string | null {
    return this._fatalErrorCode
  }

  get fatalErrorRetryable(): boolean {
    return this._fatalErrorRetryable
  }

  // ─── Lifecycle ───

  setMessageHandler(handler: MessageHandler): void {
    this._messageHandler = handler
  }

  setFatalErrorHandler(handler: (adapter: BasePlatformAdapter) => Promise<void>): void {
    this._fatalErrorHandler = handler
  }

  protected markConnected(): void {
    this._running = true
    this._fatalErrorCode = null
    this._fatalErrorMessage = null
    this._fatalErrorRetryable = true
    console.log(`[gateway] ${this.name} connected`)
  }

  protected markDisconnected(): void {
    this._running = false
    console.log(`[gateway] ${this.name} disconnected`)
  }

  protected setFatalError(code: string, message: string, retryable: boolean): void {
    this._running = false
    this._fatalErrorCode = code
    this._fatalErrorMessage = message
    this._fatalErrorRetryable = retryable
    console.error(`[gateway] ${this.name} fatal error [${code}]: ${message}`)
  }

  protected async notifyFatalError(): Promise<void> {
    if (this._fatalErrorHandler) {
      await this._fatalErrorHandler(this)
    }
  }

  // ─── Abstract methods (must implement) ───

  abstract connect(): Promise<boolean>
  abstract disconnect(): Promise<void>

  abstract send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult>

  abstract getChatInfo(chatId: string): Promise<ChatInfo>

  // ─── Optional overrides (with defaults) ───

  async editMessage(
    _chatId: string,
    _messageId: string,
    _content: string,
  ): Promise<SendResult> {
    return { success: false, error: 'Not supported' }
  }

  async sendTyping(_chatId: string, _metadata?: Record<string, unknown>): Promise<void> {
    // No-op by default
  }

  async stopTyping(_chatId: string): Promise<void> {
    // No-op by default
  }

  async sendImage(
    chatId: string,
    imageUrl: string,
    caption?: string,
    replyTo?: string,
    _metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const text = caption ? `${caption}\n${imageUrl}` : imageUrl
    return this.send(chatId, text, replyTo)
  }

  async sendAnimation(
    chatId: string,
    animationUrl: string,
    caption?: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    return this.sendImage(chatId, animationUrl, caption, replyTo, metadata)
  }

  async sendVoice(
    chatId: string,
    _voicePath: string,
    caption?: string,
    replyTo?: string,
  ): Promise<SendResult> {
    return this.send(chatId, caption ?? '[Voice message]', replyTo)
  }

  async sendDocument(
    chatId: string,
    _documentPath: string,
    caption?: string,
    replyTo?: string,
  ): Promise<SendResult> {
    return this.send(chatId, caption ?? '[Document]', replyTo)
  }

  async sendVideo(
    chatId: string,
    _videoUrl: string,
    caption?: string,
    replyTo?: string,
  ): Promise<SendResult> {
    return this.send(chatId, caption ?? '[Video]', replyTo)
  }

  /**
   * Format message content for the platform's preferred markdown dialect.
   * Override in subclasses that use custom formatting (e.g. Telegram MarkdownV2).
   */
  formatMessage(content: string): string {
    return content
  }

  // ─── Message processing ───

  /**
   * Handle an incoming message event. Routes to the message handler
   * or queues if a session is already active.
   */
  async handleMessage(event: MessageEvent): Promise<void> {
    if (!this._messageHandler) {
      console.warn(`[${this.name}] No message handler set, ignoring message`)
      return
    }

    const sessionKey = `${event.source.platform}:${event.source.chatType}:${event.source.chatId}`

    // Check if session is already active
    if (this._activeSessions.has(sessionKey)) {
      this._pendingMessages.set(sessionKey, event)
      return
    }

    const controller = new AbortController()
    this._activeSessions.set(sessionKey, controller)

    try {
      const response = await this._messageHandler(event)
      if (response) {
        await this.send(event.source.chatId, response)
      }
    } catch (err) {
      console.error(`[${this.name}] Message handling error:`, err)
    } finally {
      this._activeSessions.delete(sessionKey)

      // Process pending message if one arrived during processing
      const pending = this._pendingMessages.get(sessionKey)
      if (pending) {
        this._pendingMessages.delete(sessionKey)
        // Process in next tick to avoid stack overflow
        setImmediate(() => this.handleMessage(pending))
      }
    }
  }

  // ─── Message truncation ───

  /**
   * Truncate a message to fit within platform limits, splitting at
   * reasonable boundaries (newlines, word boundaries).
   * Returns an array of chunks.
   */
  truncateMessage(content: string, limit?: number): string[] {
    const maxLen = limit ?? this.MAX_MESSAGE_LENGTH
    if (content.length <= maxLen) return [content]

    const chunks: string[] = []
    let remaining = content

    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n', maxLen)
      if (splitAt < maxLen / 2) {
        splitAt = remaining.lastIndexOf(' ', maxLen)
      }
      if (splitAt < maxLen / 2) {
        splitAt = maxLen
      }
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).replace(/^\n+/, '')
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }

  // ─── Image extraction ───

  static extractImages(content: string): [Array<[string, string]>, string] {
    const images: Array<[string, string]> = []
    let cleaned = content
    const mdPattern = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
    for (const match of content.matchAll(mdPattern)) {
      const [, alt, url] = match
      const lower = url.toLowerCase()
      if (
        ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(
          ext => lower.endsWith(ext) || lower.includes(ext),
        ) ||
        lower.includes('fal.media') ||
        lower.includes('fal-cdn') ||
        lower.includes('replicate.delivery')
      ) {
        images.push([url, alt])
      }
    }
    if (images.length) {
      cleaned = cleaned.replace(mdPattern, '').trim()
    }
    return [images, cleaned]
  }

  static isAnimationUrl(url: string): boolean {
    return url.toLowerCase().split('?')[0].endsWith('.gif')
  }

  // ─── Retry helpers ───

  protected isRetryableError(error: string): boolean {
    const lower = error.toLowerCase().replace(/[\s_-]/g, '')
    return RETRYABLE_ERROR_PATTERNS.some(p => lower.includes(p))
  }

  protected async sendWithRetry(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
    maxRetries = 2,
  ): Promise<SendResult> {
    let lastResult: SendResult = { success: false, error: 'No attempts' }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      lastResult = await this.send(chatId, content, replyTo, metadata)
      if (lastResult.success) return lastResult
      if (!lastResult.retryable && !this.isRetryableError(lastResult.error ?? '')) {
        return lastResult
      }
      const delay = Math.min(1000 * 2 ** attempt, 10000)
      await new Promise(r => setTimeout(r, delay))
    }
    return lastResult
  }
}
