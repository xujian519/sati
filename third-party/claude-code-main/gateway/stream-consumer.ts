/**
 * Gateway streaming consumer — bridges SSE deltas to progressive platform message edits.
 *
 * Flow:
 *   1. Receives text deltas via onDelta() (called from SSE reader)
 *   2. Buffers and rate-limits edits according to StreamConsumerConfig
 *   3. Progressively edits a single platform message via adapter.editMessage()
 *   4. Falls back to sending a new message if edits aren't supported/fail
 *
 * Ported from hermes-agent gateway/stream_consumer.py.
 */

import type { SendResult } from './types'
import type { BasePlatformAdapter } from './platforms/base'

const DONE = Symbol('DONE')
const NEW_SEGMENT = Symbol('NEW_SEGMENT')
const COMMENTARY = Symbol('COMMENTARY')

export interface StreamConsumerConfig {
  editInterval: number
  bufferThreshold: number
  cursor: string
}

const DEFAULT_CONFIG: StreamConsumerConfig = {
  editInterval: 1.0,
  bufferThreshold: 40,
  cursor: ' ▉',
}

export class GatewayStreamConsumer {
  private adapter: BasePlatformAdapter
  private chatId: string
  private cfg: StreamConsumerConfig
  private metadata: Record<string, unknown> | undefined

  private queue: Array<string | symbol | [symbol, string]> = []
  private accumulated = ''
  private messageId: string | null = null
  private alreadySentFlag = false
  private editSupported = true
  private lastEditTime = 0
  private lastSentText = ''
  private fallbackFinalSend = false
  private fallbackPrefix = ''
  private floodStrikes = 0
  private currentEditInterval: number
  private finalResponseSentFlag = false

  private resolveWait: (() => void) | null = null

  static readonly MAX_FLOOD_STRIKES = 3

  constructor(
    adapter: BasePlatformAdapter,
    chatId: string,
    config?: Partial<StreamConsumerConfig>,
    metadata?: Record<string, unknown>,
  ) {
    this.adapter = adapter
    this.chatId = chatId
    this.cfg = { ...DEFAULT_CONFIG, ...config }
    this.metadata = metadata
    this.currentEditInterval = this.cfg.editInterval
  }

  get alreadySent(): boolean {
    return this.alreadySentFlag
  }

  get finalResponseSent(): boolean {
    return this.finalResponseSentFlag
  }

  onDelta(text: string | null): void {
    if (text) {
      this.queue.push(text)
    } else if (text === null) {
      this.onSegmentBreak()
    }
    this.wake()
  }

  onSegmentBreak(): void {
    this.queue.push(NEW_SEGMENT)
    this.wake()
  }

  onCommentary(text: string): void {
    if (text) {
      this.queue.push([COMMENTARY, text])
      this.wake()
    }
  }

  finish(): void {
    this.queue.push(DONE)
    this.wake()
  }

  private wake(): void {
    if (this.resolveWait) {
      this.resolveWait()
      this.resolveWait = null
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.resolveWait = resolve
      setTimeout(() => {
        this.resolveWait = null
        resolve()
      }, ms)
    })
  }

  private resetSegmentState(preserveNoEdit = false): void {
    if (preserveNoEdit && this.messageId === '__no_edit__') return
    this.messageId = null
    this.accumulated = ''
    this.lastSentText = ''
    this.fallbackFinalSend = false
    this.fallbackPrefix = ''
  }

  async run(): Promise<void> {
    const rawLimit = this.adapter.MAX_MESSAGE_LENGTH
    const safeLimit = Math.max(500, rawLimit - this.cfg.cursor.length - 100)

    try {
      while (true) {
        let gotDone = false
        let gotSegmentBreak = false
        let commentaryText: string | null = null

        // Drain all available items
        while (this.queue.length > 0) {
          const item = this.queue.shift()!
          if (item === DONE) {
            gotDone = true
            break
          }
          if (item === NEW_SEGMENT) {
            gotSegmentBreak = true
            break
          }
          if (Array.isArray(item) && item[0] === COMMENTARY) {
            commentaryText = item[1]
            break
          }
          this.accumulated += item as string
        }

        const elapsed = (Date.now() / 1000) - this.lastEditTime
        const shouldEdit =
          gotDone ||
          gotSegmentBreak ||
          commentaryText !== null ||
          (elapsed >= this.currentEditInterval && this.accumulated.length > 0) ||
          this.accumulated.length >= this.cfg.bufferThreshold

        let currentUpdateVisible = false

        if (shouldEdit && this.accumulated) {
          // Overflow: split if too large and no existing message
          if (this.accumulated.length > safeLimit && this.messageId === null) {
            const chunks = this.adapter.truncateMessage(this.accumulated, safeLimit)
            for (const chunk of chunks) {
              await this.sendNewChunk(chunk, this.messageId)
            }
            this.accumulated = ''
            this.lastSentText = ''
            this.lastEditTime = Date.now() / 1000
            if (gotDone) {
              this.finalResponseSentFlag = this.alreadySentFlag
              return
            }
            if (gotSegmentBreak) {
              this.messageId = null
              this.fallbackFinalSend = false
              this.fallbackPrefix = ''
            }
            continue
          }

          // Edit existing message: split overflow
          while (
            this.accumulated.length > safeLimit &&
            this.messageId !== null &&
            this.editSupported
          ) {
            let splitAt = this.accumulated.lastIndexOf('\n', safeLimit)
            if (splitAt < safeLimit / 2) splitAt = safeLimit
            const chunk = this.accumulated.slice(0, splitAt)
            const ok = await this.sendOrEdit(chunk)
            if (this.fallbackFinalSend || !ok) break
            this.accumulated = this.accumulated.slice(splitAt).replace(/^\n+/, '')
            this.messageId = null
            this.lastSentText = ''
          }

          let displayText = this.accumulated
          if (!gotDone && !gotSegmentBreak && commentaryText === null) {
            displayText += this.cfg.cursor
          }

          currentUpdateVisible = await this.sendOrEdit(displayText)
          this.lastEditTime = Date.now() / 1000
        }

        if (gotDone) {
          if (this.accumulated) {
            if (this.fallbackFinalSend) {
              await this.sendFallbackFinal(this.accumulated)
            } else if (currentUpdateVisible) {
              this.finalResponseSentFlag = true
            } else if (this.messageId) {
              this.finalResponseSentFlag = await this.sendOrEdit(this.accumulated)
            } else if (!this.alreadySentFlag) {
              this.finalResponseSentFlag = await this.sendOrEdit(this.accumulated)
            }
          }
          return
        }

        if (commentaryText !== null) {
          this.resetSegmentState()
          await this.sendCommentary(commentaryText)
          this.lastEditTime = Date.now() / 1000
          this.resetSegmentState()
        }

        if (gotSegmentBreak) {
          this.resetSegmentState(true)
        }

        await this.wait(50)
      }
    } catch (err) {
      if (this.accumulated && this.messageId) {
        try { await this.sendOrEdit(this.accumulated) } catch {}
      }
      if (this.alreadySentFlag) this.finalResponseSentFlag = true
      if (!(err instanceof Error && err.name === 'AbortError')) {
        console.error('[stream-consumer] Error:', err)
      }
    }
  }

  // ─── Internals ───

  private static cleanForDisplay(text: string): string {
    if (!text.includes('MEDIA:') && !text.includes('[[audio_as_voice]]')) return text
    let cleaned = text.replace(/\[\[audio_as_voice\]\]/g, '')
    cleaned = cleaned.replace(/[`"']?MEDIA:\s*\S+[`"']?/g, '')
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
    return cleaned.trimEnd()
  }

  private async sendNewChunk(text: string, replyToId: string | null): Promise<string | null> {
    text = GatewayStreamConsumer.cleanForDisplay(text)
    if (!text.trim()) return replyToId
    try {
      const result = await this.adapter.send(
        this.chatId,
        text,
        replyToId ?? undefined,
        this.metadata,
      )
      if (result.success && result.messageId) {
        this.messageId = result.messageId
        this.alreadySentFlag = true
        this.lastSentText = text
        return result.messageId
      }
      this.editSupported = false
      return replyToId
    } catch (err) {
      console.error('[stream-consumer] Send chunk error:', err)
      return replyToId
    }
  }

  private visiblePrefix(): string {
    let prefix = this.lastSentText || ''
    if (this.cfg.cursor && prefix.endsWith(this.cfg.cursor)) {
      prefix = prefix.slice(0, -this.cfg.cursor.length)
    }
    return GatewayStreamConsumer.cleanForDisplay(prefix)
  }

  private continuationText(finalText: string): string {
    const prefix = this.fallbackPrefix || this.visiblePrefix()
    if (prefix && finalText.startsWith(prefix)) {
      return finalText.slice(prefix.length).trimStart()
    }
    return finalText
  }

  private isFloodError(result: SendResult): boolean {
    const err = (result.error ?? '').toLowerCase()
    return err.includes('flood') || err.includes('retry after') || err.includes('rate')
  }

  private async sendCommentary(text: string): Promise<boolean> {
    text = GatewayStreamConsumer.cleanForDisplay(text)
    if (!text.trim()) return false
    try {
      const result = await this.adapter.send(this.chatId, text, undefined, this.metadata)
      if (result.success) {
        this.alreadySentFlag = true
        return true
      }
    } catch (err) {
      console.error('[stream-consumer] Commentary send error:', err)
    }
    return false
  }

  private async sendOrEdit(text: string): Promise<boolean> {
    text = GatewayStreamConsumer.cleanForDisplay(text)
    const visibleWithoutCursor = this.cfg.cursor
      ? text.replace(new RegExp(escapeRegex(this.cfg.cursor), 'g'), '')
      : text
    if (!visibleWithoutCursor.trim()) return true
    if (!text.trim()) return true

    try {
      if (this.messageId !== null) {
        if (this.editSupported) {
          if (text === this.lastSentText) return true
          const result = await this.adapter.editMessage(this.chatId, this.messageId, text)
          if (result.success) {
            this.alreadySentFlag = true
            this.lastSentText = text
            this.floodStrikes = 0
            return true
          }

          if (this.isFloodError(result)) {
            this.floodStrikes++
            this.currentEditInterval = Math.min(this.currentEditInterval * 2, 10.0)
            if (this.floodStrikes < GatewayStreamConsumer.MAX_FLOOD_STRIKES) {
              this.lastEditTime = Date.now() / 1000
              return false
            }
          }

          this.fallbackPrefix = this.visiblePrefix()
          this.fallbackFinalSend = true
          this.editSupported = false
          this.alreadySentFlag = true
          return false
        }
        return false
      }

      // First message — send new
      const result = await this.adapter.send(this.chatId, text, undefined, this.metadata)
      if (result.success) {
        if (result.messageId) {
          this.messageId = result.messageId
        } else {
          this.editSupported = false
          this.fallbackPrefix = this.visiblePrefix()
          this.fallbackFinalSend = true
          this.messageId = '__no_edit__'
        }
        this.alreadySentFlag = true
        this.lastSentText = text
        return true
      }
      this.editSupported = false
      return false
    } catch (err) {
      console.error('[stream-consumer] Send/edit error:', err)
      return false
    }
  }

  private async sendFallbackFinal(text: string): Promise<void> {
    const finalText = GatewayStreamConsumer.cleanForDisplay(text)
    const continuation = this.continuationText(finalText)
    this.fallbackFinalSend = false
    if (!continuation.trim()) {
      this.alreadySentFlag = true
      this.finalResponseSentFlag = true
      return
    }

    const rawLimit = this.adapter.MAX_MESSAGE_LENGTH
    const safeLimit = Math.max(500, rawLimit - 100)
    const chunks = splitTextChunks(continuation, safeLimit)

    let lastMessageId: string | null = null
    let sentAny = false

    for (const chunk of chunks) {
      let result: SendResult | null = null
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await this.adapter.send(this.chatId, chunk, undefined, this.metadata)
        if (result.success) break
        if (attempt === 0 && this.isFloodError(result)) {
          await new Promise(r => setTimeout(r, 3000))
        } else {
          break
        }
      }
      if (!result?.success) {
        if (sentAny) {
          this.alreadySentFlag = true
          this.finalResponseSentFlag = true
          this.messageId = lastMessageId
        }
        return
      }
      sentAny = true
      lastMessageId = result.messageId ?? lastMessageId
    }

    this.messageId = lastMessageId
    this.alreadySentFlag = true
    this.finalResponseSentFlag = true
  }
}

function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit / 2) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
