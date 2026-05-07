/**
 * WeCom (Enterprise WeChat) self-built app — callback mode (encrypted XML over HTTP).
 *
 * Inbound: local HTTP server; WXBizMsgCrypt AES-256-CBC + SHA1 signature.
 * Outbound: qyapi.weixin.qq.com message/send with cached access_token.
 */

import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { URL } from 'node:url'
import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

const QYAPI = 'https://qyapi.weixin.qq.com/cgi-bin'
const DEFAULT_PORT = 8780
const TOKEN_TTL_MS = 7000 * 1000

function extra(config: PlatformConfig, key: string): unknown {
  return config.extra?.[key]
}

function sha1Hex(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function verifyMsgSignature(token: string, timestamp: string, nonce: string, msgEncrypt: string, sig: string): boolean {
  const sorted = [token, timestamp, nonce, msgEncrypt].sort().join('')
  return sha1Hex(sorted) === sig
}

/** WXBizMsgCrypt: decrypt base64 ciphertext → inner XML / echostr */
function decryptWxMessage(encodingAesKeyB43: string, ciphertextB64: string, expectCorpId?: string): string {
  const key = Buffer.from(encodingAesKeyB43 + '=', 'base64')
  if (key.length !== 32) throw new Error('encodingAesKey must decode to 32 bytes')
  const iv = key.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  let raw = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()])
  const pad = raw[raw.length - 1]
  if (pad > 32 || pad < 1) throw new Error('invalid PKCS#7 padding')
  raw = raw.subarray(0, raw.length - pad)
  const content = raw.subarray(16)
  const xmlLen = content.readUInt32BE(0)
  const tail = content.subarray(4 + xmlLen).toString('utf8')
  if (expectCorpId && tail && tail !== expectCorpId) {
    throw new Error('corpId mismatch after decrypt')
  }
  return content.subarray(4, 4 + xmlLen).toString('utf8')
}

function xmlTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([^<]*)</${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return undefined
  return (m[1] ?? m[2] ?? '').trim()
}

function extractEncryptFromXml(xml: string): string | undefined {
  const cdata = xml.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/i)?.[1]?.trim()
  if (cdata) return cdata
  return xml.match(/<Encrypt>([^<]+)<\/Encrypt>/i)?.[1]?.trim()
}

export class WeComCallbackAdapter extends BasePlatformAdapter {
  private readonly corpId: string
  private readonly callbackToken: string
  private readonly encodingAesKey: string
  private readonly corpSecret: string
  private readonly agentId: string
  private readonly port: number

  private server: http.Server | null = null
  private accessToken: string | null = null
  private accessTokenExpires = 0

  constructor(config: PlatformConfig) {
    super(config, Platform.WECOM_CALLBACK)
    const ex = config.extra ?? {}
    this.corpId = String(extra(config, 'corpId') ?? ex.corpid ?? '').trim()
    this.callbackToken = String(extra(config, 'callbackToken') ?? ex.token ?? '').trim()
    this.encodingAesKey = String(extra(config, 'encodingAesKey') ?? ex.encoding_aes_key ?? '').trim()
    this.corpSecret = String(extra(config, 'corpSecret') ?? ex.secret ?? '').trim()
    this.agentId = String(extra(config, 'agentId') ?? ex.agentid ?? '').trim()
    const p = Number(extra(config, 'port') ?? DEFAULT_PORT)
    this.port = Number.isFinite(p) && p > 0 ? Math.floor(p) : DEFAULT_PORT
  }

  async connect(): Promise<boolean> {
    if (!this.corpId || !this.callbackToken || !this.encodingAesKey) {
      this.setFatalError(
        'wecom_cb_config',
        'config.extra.corpId, callbackToken, and encodingAesKey are required',
        false,
      )
      return false
    }
    if (!this.corpSecret || !this.agentId) {
      this.setFatalError(
        'wecom_cb_send',
        'config.extra.corpSecret and agentId are required for outbound send',
        false,
      )
      return false
    }

    try {
      this.server = http.createServer((req, res) => void this.onHttp(req, res))
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(this.port, '0.0.0.0', () => resolve())
      })
      this.markConnected()
      console.log(`[wecom-callback] listening on 0.0.0.0:${this.port}`)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.setFatalError('wecom_cb_listen', msg, false)
      return false
    }
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const q = url.searchParams

      if (req.method === 'GET') {
        const msgSig = q.get('msg_signature') ?? ''
        const timestamp = q.get('timestamp') ?? ''
        const nonce = q.get('nonce') ?? ''
        const echostr = q.get('echostr') ?? ''
        if (!echostr) {
          res.writeHead(400).end('missing echostr')
          return
        }
        if (!verifyMsgSignature(this.callbackToken, timestamp, nonce, echostr, msgSig)) {
          res.writeHead(403).end('signature')
          return
        }
        const plain = decryptWxMessage(this.encodingAesKey, echostr, this.corpId)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(plain)
        return
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        const msgSig = q.get('msg_signature') ?? ''
        const timestamp = q.get('timestamp') ?? ''
        const nonce = q.get('nonce') ?? ''
        const encryptNode = extractEncryptFromXml(body)
        if (!encryptNode) {
          res.writeHead(400).end('no Encrypt')
          return
        }
        if (!verifyMsgSignature(this.callbackToken, timestamp, nonce, encryptNode, msgSig)) {
          res.writeHead(403).end('signature')
          return
        }
        const innerXml = decryptWxMessage(this.encodingAesKey, encryptNode, this.corpId)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('success')

        void this.dispatchInboundXml(innerXml)
        return
      }

      res.writeHead(405).end()
    } catch (e) {
      console.error('[wecom-callback] HTTP error:', e)
      try {
        res.writeHead(500).end('error')
      } catch {
        /* ignore */
      }
    }
  }

  private async dispatchInboundXml(xml: string): Promise<void> {
    const msgType = xmlTag(xml, 'MsgType') ?? 'text'
    const from = xmlTag(xml, 'FromUserName') ?? ''
    const agentId = xmlTag(xml, 'AgentId') ?? this.agentId
    const msgId = xmlTag(xml, 'MsgId') ?? ''
    let text = ''
    if (msgType === 'text') text = xmlTag(xml, 'Content') ?? ''
    else text = `[${msgType}]`

    const chatId = from
    const source = {
      platform: Platform.WECOM_CALLBACK,
      chatId,
      chatName: undefined,
      chatType: 'dm' as const,
      userId: from,
      userName: undefined,
      threadId: agentId,
    }
    const base = createMessageEvent(text, source)
    const event = {
      ...base,
      messageId: msgId || undefined,
      messageType: MessageType.TEXT,
      mediaUrls: [],
      mediaTypes: [],
    }
    void this.handleMessage(event)
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    this.markDisconnected()
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && now < this.accessTokenExpires) return this.accessToken

    const url = `${QYAPI}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
    if (!res.ok || data.errcode != null && data.errcode !== 0) {
      throw new Error(data.errmsg ?? `gettoken failed (${res.status})`)
    }
    if (!data.access_token) throw new Error('gettoken: no access_token')
    this.accessToken = data.access_token
    const sec = typeof data.expires_in === 'number' ? data.expires_in : 7200
    this.accessTokenExpires = Date.now() + Math.min(sec * 1000 - 60_000, TOKEN_TTL_MS)
    return this.accessToken
  }

  async send(chatId: string, content: string, _replyTo?: string, _metadata?: Record<string, unknown>): Promise<SendResult> {
    try {
      const token = await this.getAccessToken()
      const url = `${QYAPI}/message/send?access_token=${encodeURIComponent(token)}`
      const body = {
        touser: chatId,
        msgtype: 'text',
        agentid: Number(this.agentId),
        text: { content: this.formatMessage(content).slice(0, 2048) },
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const raw = await res.json().catch(() => ({}))
      const errcode = (raw as { errcode?: number }).errcode
      if (!res.ok || (errcode != null && errcode !== 0)) {
        const err = (raw as { errmsg?: string }).errmsg ?? res.statusText
        if (errcode === 40014 || errcode === 42001) {
          this.accessToken = null
        }
        return {
          success: false,
          error: err,
          rawResponse: raw,
          retryable: errcode === 40014 || errcode === 42001,
        }
      }
      return { success: true, rawResponse: raw }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg, retryable: this.isRetryableError(msg) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return { name: chatId, type: 'dm' }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
