/**
 * OpenAI-compatible API server platform adapter.
 *
 * Exposes a Bun HTTP server with endpoints:
 * - POST /v1/chat/completions — OpenAI Chat Completions format
 * - GET  /v1/models          — lists available models
 * - GET  /health              — health check
 *
 * Any OpenAI-compatible frontend (Open WebUI, LobeChat, LibreChat,
 * AnythingLLM, NextChat, ChatBox, etc.) can connect through this adapter.
 *
 * Ported from hermes-agent gateway/platforms/api_server.py.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform } from '../types'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8642
const MAX_REQUEST_BYTES = 1_000_000

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hermes-Session-Id',
  'Access-Control-Expose-Headers': 'X-Hermes-Session-Id',
}

export class APIServerAdapter extends BasePlatformAdapter {
  private host: string
  private port: number
  private apiKey: string
  private corsOrigins: string[]
  private modelName: string
  private server: ReturnType<typeof Bun.serve> | null = null

  // Pending response resolvers: requestId -> resolve function
  private pendingResponses = new Map<
    string,
    {
      resolve: (response: string) => void
      stream?: boolean
      controller?: ReadableStreamDefaultController
    }
  >()

  constructor(config: PlatformConfig) {
    super(config, Platform.API_SERVER)
    const extra = config.extra || {}
    this.host = (extra.host as string) ?? process.env.API_SERVER_HOST ?? DEFAULT_HOST
    this.port = Number(extra.port ?? process.env.API_SERVER_PORT ?? DEFAULT_PORT)
    this.apiKey = (extra.key as string) ?? config.apiKey ?? process.env.API_SERVER_KEY ?? ''
    this.corsOrigins = this.parseCorsOrigins(
      extra.corsOrigins ?? process.env.API_SERVER_CORS_ORIGINS ?? '',
    )
    this.modelName = (extra.modelName as string) ?? process.env.API_SERVER_MODEL_NAME ?? 'claude-gateway'
  }

  private parseCorsOrigins(value: unknown): string[] {
    if (!value) return []
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    return []
  }

  private checkAuth(req: Request): Response | null {
    if (!this.apiKey) return null
    const auth = req.headers.get('Authorization') ?? ''
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim()
      const a = Buffer.from(token)
      const b = Buffer.from(this.apiKey)
      if (a.length === b.length && timingSafeEqual(a, b)) return null
    }
    return Response.json(
      { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
      { status: 401 },
    )
  }

  private getCorsHeaders(origin: string | null): Record<string, string> | null {
    if (!origin || this.corsOrigins.length === 0) return null
    if (this.corsOrigins.includes('*')) {
      return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': '*' }
    }
    if (this.corsOrigins.includes(origin)) {
      return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    }
    return null
  }

  async connect(): Promise<boolean> {
    try {
      this.server = Bun.serve({
        hostname: this.host,
        port: this.port,
        fetch: (req) => this.handleRequest(req),
      })
      this.markConnected()
      console.log(`[api-server] Listening on http://${this.host}:${this.port}`)
      return true
    } catch (err) {
      console.error('[api-server] Failed to start:', err)
      this.setFatalError('api_server_start', String(err), true)
      return false
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    _replyTo?: string,
    _metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const pending = this.pendingResponses.get(chatId)
    if (pending) {
      if (pending.stream && pending.controller) {
        // Send as SSE chunk
        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.modelName,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }
        pending.controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`),
        )
      } else {
        pending.resolve(content)
        this.pendingResponses.delete(chatId)
      }
      return { success: true, messageId: chatId }
    }
    console.log(`[api-server] Response for ${chatId}: ${content.slice(0, 100)}`)
    return { success: true }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm' }
  }

  // ─── HTTP handling ───

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const origin = req.headers.get('Origin')
    const cors = this.getCorsHeaders(origin)

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: cors ?? {},
      })
    }

    const addCors = (resp: Response): Response => {
      if (cors) {
        for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v)
      }
      return resp
    }

    if (url.pathname === '/health') {
      return addCors(Response.json({ status: 'ok', platform: 'api-server' }))
    }

    if (url.pathname === '/v1/models') {
      return addCors(
        Response.json({
          object: 'list',
          data: [
            {
              id: this.modelName,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'gateway',
            },
          ],
        }),
      )
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const authErr = this.checkAuth(req)
      if (authErr) return addCors(authErr)
      return addCors(await this.handleChatCompletions(req))
    }

    return addCors(new Response('Not Found', { status: 404 }))
  }

  private async handleChatCompletions(req: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      const text = await req.text()
      if (text.length > MAX_REQUEST_BYTES) {
        return Response.json(
          { error: { message: 'Request too large', type: 'invalid_request_error' } },
          { status: 413 },
        )
      }
      body = JSON.parse(text)
    } catch {
      return Response.json(
        { error: { message: 'Invalid JSON', type: 'invalid_request_error' } },
        { status: 400 },
      )
    }

    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined
    if (!messages || !Array.isArray(messages)) {
      return Response.json(
        { error: { message: 'messages is required', type: 'invalid_request_error' } },
        { status: 400 },
      )
    }

    // Normalize content to string
    const lastMsg = messages[messages.length - 1]
    const userText = this.normalizeContent(lastMsg?.content)
    if (!userText) {
      return Response.json(
        { error: { message: 'Empty message', type: 'invalid_request_error' } },
        { status: 400 },
      )
    }

    const requestId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const streaming = body.stream === true

    // Build MessageEvent and send to handler
    const event = {
      text: userText,
      messageType: 'text' as const,
      source: {
        platform: Platform.API_SERVER,
        chatId: requestId,
        chatType: 'dm' as const,
        userId: req.headers.get('X-Hermes-Session-Id') ?? 'api-user',
      },
      mediaUrls: [] as string[],
      mediaTypes: [] as string[],
      internal: false,
      timestamp: new Date(),
    }

    if (streaming) {
      return this.handleStreamingRequest(event, requestId)
    }

    return this.handleNonStreamingRequest(event, requestId)
  }

  private handleStreamingRequest(event: any, requestId: string): Response {
    const stream = new ReadableStream({
      start: async (controller) => {
        this.pendingResponses.set(requestId, {
          resolve: () => {},
          stream: true,
          controller,
        })

        try {
          const response = await this.handleMessage(event)

          // Send final chunk if handleMessage returned text
          if (response) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: this.modelName,
              choices: [{ index: 0, delta: { content: response }, finish_reason: null }],
            }
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`),
            )
          }

          // Send done
          const doneChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`),
          )
        } catch (err) {
          const errorChunk = {
            error: { message: String(err), type: 'server_error' },
          }
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`),
          )
        } finally {
          this.pendingResponses.delete(requestId)
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  private async handleNonStreamingRequest(event: any, requestId: string): Promise<Response> {
    return new Promise<Response>((resolveHttp) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId)
        resolveHttp(
          Response.json(
            { error: { message: 'Request timeout', type: 'server_error' } },
            { status: 504 },
          ),
        )
      }, 300_000)

      this.pendingResponses.set(requestId, {
        resolve: (content: string) => {
          clearTimeout(timeout)
          resolveHttp(
            Response.json({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: this.modelName,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }),
          )
        },
      })

      this.handleMessage(event).then((response) => {
        if (response && this.pendingResponses.has(requestId)) {
          const pending = this.pendingResponses.get(requestId)!
          pending.resolve(response)
          this.pendingResponses.delete(requestId)
        }
      }).catch((err) => {
        clearTimeout(timeout)
        this.pendingResponses.delete(requestId)
        resolveHttp(
          Response.json(
            { error: { message: String(err), type: 'server_error' } },
            { status: 500 },
          ),
        )
      })
    })
  }

  private normalizeContent(content: unknown): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((item: any) => {
          if (typeof item === 'string') return item
          if (item?.type === 'text' || item?.type === 'input_text') return item.text ?? ''
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return String(content)
  }
}
