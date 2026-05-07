/**
 * Generic webhook receiver adapter.
 *
 * Accepts HTTP POST webhooks, validates HMAC signatures,
 * and routes messages through the gateway.
 *
 * Ported from hermes-agent gateway/platforms/webhook.py.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType } from '../types'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8643
const INSECURE_NO_AUTH = '__INSECURE_NO_AUTH__'

interface WebhookRoute {
  secret: string
  deliver?: string
  description?: string
  [key: string]: unknown
}

export class WebhookAdapter extends BasePlatformAdapter {
  private host: string
  private port: number
  private globalSecret: string
  private routes: Record<string, WebhookRoute>
  private server: ReturnType<typeof Bun.serve> | null = null
  private deliveryInfo = new Map<string, Record<string, unknown>>()
  private deliveryInfoCreated = new Map<string, number>()
  private seenDeliveries = new Map<string, number>()
  private rateLimit: number
  private rateCounts = new Map<string, number[]>()
  private maxBodyBytes: number

  constructor(config: PlatformConfig) {
    super(config, Platform.WEBHOOK)
    const extra = config.extra || {}
    this.host = (extra.host as string) ?? DEFAULT_HOST
    this.port = Number(extra.port ?? DEFAULT_PORT)
    this.globalSecret = (extra.secret as string) ?? ''
    this.routes = (extra.routes as Record<string, WebhookRoute>) ?? {}
    this.rateLimit = Number(extra.rate_limit ?? 30)
    this.maxBodyBytes = Number(extra.max_body_bytes ?? 1_048_576)
  }

  async connect(): Promise<boolean> {
    // Validate routes
    for (const [name, route] of Object.entries(this.routes)) {
      const secret = route.secret || this.globalSecret
      if (!secret) {
        console.error(
          `[webhook] Route '${name}' has no HMAC secret. ` +
          `Set 'secret' on the route or globally. ` +
          `For testing without auth, set secret to '${INSECURE_NO_AUTH}'.`,
        )
        return false
      }
    }

    try {
      this.server = Bun.serve({
        hostname: this.host,
        port: this.port,
        fetch: (req) => this.handleRequest(req),
      })
      this.markConnected()
      const routeNames = Object.keys(this.routes).join(', ') || '(none configured)'
      console.log(`[webhook] Listening on http://${this.host}:${this.port} — routes: ${routeNames}`)
      return true
    } catch (err) {
      console.error('[webhook] Failed to start:', err)
      this.setFatalError('webhook_start', String(err), true)
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
    const delivery = this.deliveryInfo.get(chatId)
    const deliverType = (delivery?.deliver as string) ?? 'log'

    if (deliverType === 'log') {
      console.log(`[webhook] Response for ${chatId}: ${content.slice(0, 200)}`)
      return { success: true }
    }

    console.log(`[webhook] Deliver type '${deliverType}' for ${chatId}: ${content.slice(0, 100)}`)
    return { success: true }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm' }
  }

  // ─── HTTP handling ───

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', platform: 'webhook' })
    }

    const match = url.pathname.match(/^\/webhooks\/([^/]+)$/)
    if (match && req.method === 'POST') {
      return this.handleWebhook(req, match[1])
    }

    return new Response('Not Found', { status: 404 })
  }

  private async handleWebhook(req: Request, routeName: string): Promise<Response> {
    const route = this.routes[routeName]
    if (!route) {
      return Response.json(
        { error: `Unknown route: ${routeName}` },
        { status: 404 },
      )
    }

    // Rate limiting
    const now = Date.now() / 1000
    if (!this.checkRateLimit(routeName, now)) {
      return Response.json(
        { error: 'Rate limit exceeded' },
        { status: 429 },
      )
    }

    // Read body
    let bodyText: string
    try {
      bodyText = await req.text()
      if (bodyText.length > this.maxBodyBytes) {
        return Response.json(
          { error: 'Request too large' },
          { status: 413 },
        )
      }
    } catch {
      return Response.json(
        { error: 'Failed to read body' },
        { status: 400 },
      )
    }

    // Verify HMAC signature
    const secret = route.secret || this.globalSecret
    if (secret !== INSECURE_NO_AUTH) {
      const signature = req.headers.get('X-Hub-Signature-256') ??
                        req.headers.get('X-Signature-256') ?? ''
      if (!this.verifyHmac(bodyText, secret, signature)) {
        return Response.json(
          { error: 'Invalid signature' },
          { status: 401 },
        )
      }
    }

    // Parse body
    let body: Record<string, unknown>
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = { raw: bodyText }
    }

    // Idempotency check
    const deliveryId = (req.headers.get('X-Delivery-Id') ??
                        req.headers.get('X-GitHub-Delivery') ??
                        `${routeName}-${now}`)
    if (this.seenDeliveries.has(deliveryId)) {
      return Response.json({ status: 'duplicate', delivery_id: deliveryId })
    }
    this.seenDeliveries.set(deliveryId, now)
    this.pruneSeenDeliveries(now)

    // Extract message text
    const text = this.extractText(body, route)
    if (!text) {
      return Response.json({ status: 'ignored', reason: 'no text content' })
    }

    // Store delivery info for response routing
    const chatId = `webhook:${routeName}:${deliveryId}`
    this.deliveryInfo.set(chatId, {
      deliver: route.deliver ?? 'log',
      route: routeName,
      ...body,
    })
    this.deliveryInfoCreated.set(chatId, now)
    this.pruneDeliveryInfo(now)

    // Build message event
    const event = {
      text,
      messageType: MessageType.TEXT,
      source: {
        platform: Platform.WEBHOOK,
        chatId,
        chatType: 'dm' as const,
        userId: `webhook:${routeName}`,
        userName: routeName,
      },
      mediaUrls: [] as string[],
      mediaTypes: [] as string[],
      internal: false,
      timestamp: new Date(),
    }

    // Process asynchronously
    this.handleMessage(event).catch(err => {
      console.error(`[webhook] Error processing ${routeName}:`, err)
    })

    return Response.json({
      status: 'accepted',
      delivery_id: deliveryId,
    })
  }

  private verifyHmac(body: string, secret: string, signature: string): boolean {
    if (!signature) return false
    const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature
    const expected = createHmac('sha256', secret).update(body).digest('hex')
    try {
      return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  private extractText(body: Record<string, unknown>, route: WebhookRoute): string | null {
    // Try common webhook body formats
    if (typeof body.text === 'string') return body.text
    if (typeof body.message === 'string') return body.message
    if (typeof body.content === 'string') return body.content
    if (typeof body.body === 'string') return body.body

    // GitHub webhook events
    if (body.action && body.issue && typeof (body.issue as any).body === 'string') {
      return `GitHub ${body.action}: ${(body.issue as any).title}\n${(body.issue as any).body}`
    }
    if (body.action && body.pull_request) {
      const pr = body.pull_request as Record<string, unknown>
      return `GitHub PR ${body.action}: ${pr.title}\n${pr.body ?? ''}`
    }
    if (body.comment && typeof (body.comment as any).body === 'string') {
      return `Comment: ${(body.comment as any).body}`
    }

    // Fallback: stringify the body
    const str = JSON.stringify(body)
    if (str.length > 5 && str !== '{}') return str

    return null
  }

  private checkRateLimit(routeName: string, now: number): boolean {
    const window = 60
    let timestamps = this.rateCounts.get(routeName) ?? []
    timestamps = timestamps.filter(t => t > now - window)
    if (timestamps.length >= this.rateLimit) return false
    timestamps.push(now)
    this.rateCounts.set(routeName, timestamps)
    return true
  }

  private pruneSeenDeliveries(now: number): void {
    const cutoff = now - 3600
    for (const [k, t] of this.seenDeliveries) {
      if (t < cutoff) this.seenDeliveries.delete(k)
    }
  }

  private pruneDeliveryInfo(now: number): void {
    const cutoff = now - 3600
    for (const [k, t] of this.deliveryInfoCreated) {
      if (t < cutoff) {
        this.deliveryInfo.delete(k)
        this.deliveryInfoCreated.delete(k)
      }
    }
  }
}
