/**
 * Matrix adapter using matrix-bot-sdk.
 *
 * Env / config: MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN (or config.token),
 * optional MATRIX_USER_ID + MATRIX_PASSWORD via MatrixAuth.passwordLogin.
 * Optional E2EE: extra.encryption / MATRIX_ENCRYPTION + RustSdkCryptoStorageProvider.
 *
 * Handles text, images, and files; edits via m.replace. Ported from hermes-agent matrix.py.
 *
 * Requires: matrix-bot-sdk (npm install matrix-bot-sdk)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { BasePlatformAdapter } from './base'
import type { SendResult, ChatInfo, PlatformConfig, SessionSource } from '../types'
import { Platform, MessageType, createMessageEvent } from '../types'

let MatrixSdk: any
let MatrixAuth: any
let StoreType: any
try {
  MatrixSdk = require('matrix-bot-sdk')
  MatrixAuth = MatrixSdk.MatrixAuth
} catch {
  /* optional */
}
try {
  StoreType = require('@matrix-org/matrix-sdk-crypto-nodejs').StoreType
} catch {
  /* optional — E2EE */
}

export class MatrixAdapter extends BasePlatformAdapter {
  MAX_MESSAGE_LENGTH = 4000

  private client: any = null
  private userId: string | null = null
  private encryption = false

  constructor(config: PlatformConfig) {
    super(config, Platform.MATRIX)
  }

  async connect(): Promise<boolean> {
    if (!MatrixSdk) {
      console.error('[matrix] matrix-bot-sdk not installed. Run: npm install matrix-bot-sdk')
      this.setFatalError('missing_dep', 'matrix-bot-sdk not installed', false)
      return false
    }

    const homeserver = (
      (this.config.extra.homeserver as string) ||
      process.env.MATRIX_HOMESERVER ||
      ''
    ).replace(/\/$/, '')
    const accessToken = this.config.token || process.env.MATRIX_ACCESS_TOKEN || ''
    const matrixUser = (this.config.extra.user_id as string) || process.env.MATRIX_USER_ID || ''
    const password = (this.config.extra.password as string) || process.env.MATRIX_PASSWORD || ''
    this.encryption = Boolean(
      this.config.extra.encryption ??
        ['true', '1', 'yes'].includes(String(process.env.MATRIX_ENCRYPTION || '').toLowerCase()),
    )

    const storagePath =
      (this.config.extra.storage_path as string) ||
      path.join(process.cwd(), '.matrix-bot-storage.json')
    const cryptoBase =
      (this.config.extra.crypto_store_path as string) || path.join(process.cwd(), '.matrix-crypto-store')

    if (!homeserver) {
      this.setFatalError('no_homeserver', 'MATRIX_HOMESERVER not set', false)
      return false
    }

    try {
      const { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } = MatrixSdk
      const storage = new SimpleFsStorageProvider(storagePath)

      let cryptoStore: any = undefined
      if (this.encryption) {
        if (!StoreType || !RustSdkCryptoStorageProvider) {
          console.error('[matrix] E2EE requested but @matrix-org/matrix-sdk-crypto-nodejs unavailable')
          this.setFatalError('e2ee_unavailable', 'E2EE dependencies missing', false)
          return false
        }
        fs.mkdirSync(cryptoBase, { recursive: true })
        cryptoStore = new RustSdkCryptoStorageProvider(cryptoBase, StoreType.Sqlite)
      }

      if (accessToken) {
        this.client = new MatrixClient(homeserver, accessToken, storage, cryptoStore)
      } else if (matrixUser && password) {
        const auth = new MatrixAuth(homeserver)
        const logged = await auth.passwordLogin(matrixUser, password, 'gateway-bot')
        this.client = new MatrixClient(logged.homeserverUrl, logged.accessToken, storage, cryptoStore)
      } else {
        this.setFatalError('no_creds', 'Need MATRIX_ACCESS_TOKEN or MATRIX_USER_ID + MATRIX_PASSWORD', false)
        return false
      }

      this.userId = (await this.client.getUserId()) ?? null

      this.client.on('room.invite', async (roomId: string) => {
        try {
          await this.client.joinRoom(roomId)
        } catch (e) {
          console.warn('[matrix] joinRoom failed:', e)
        }
      })

      this.client.on('room.message', async (roomId: string, raw: any) => {
        try {
          await this.onMatrixMessage(roomId, raw)
        } catch (e) {
          console.error('[matrix] room.message error:', e)
        }
      })

      await this.client.start()

      if (this.encryption && this.client.crypto) {
        const rooms = await this.client.getJoinedRooms()
        await this.client.crypto.prepare(rooms)
      }

      this.markConnected()
      console.log(`[matrix] Syncing as ${this.userId}`)
      return true
    } catch (e) {
      console.error('[matrix] connect failed:', e)
      this.setFatalError('connect_error', String(e), true)
      return false
    }
  }

  private async onMatrixMessage(roomId: string, raw: any): Promise<void> {
    const sender = raw.sender as string
    if (sender === this.userId) return

    const content = raw.content || {}
    const relates = content['m.relates_to'] || {}
    if (relates['rel_type'] === 'm.replace') return

    const msgtype = (content.msgtype as string) || 'm.text'
    if (msgtype === 'm.notice') return

    const eventId = raw.event_id as string

    if (msgtype === 'm.text') {
      const body = (content.body as string) || ''
      if (!body.trim() && !content.url) return

      const threadRoot =
        relates['rel_type'] === 'm.thread' ? (relates.event_id as string | undefined) : undefined
      const inReply = relates['m.in_reply_to']?.event_id as string | undefined

      const isDm = (await this.client.getJoinedRoomMembers(roomId)).length <= 2
      const source: SessionSource = {
        platform: Platform.MATRIX,
        chatId: roomId,
        chatName: roomId,
        chatType: isDm ? 'dm' : 'group',
        userId: sender,
        threadId: threadRoot,
      }

      const ev = createMessageEvent(body, source)
      ev.messageId = eventId
      ev.replyToMessageId = inReply
      await this.handleMessage(ev)
      return
    }

    if (['m.image', 'm.file', 'm.video', 'm.audio'].includes(msgtype)) {
      const body = (content.body as string) || ''
      const mxc = (content.url as string) || ''
      const httpUrl = mxc ? this.mxcToHttp(mxc) : ''
      const info = content.info || {}
      const mime = (info.mimetype as string) || 'application/octet-stream'

      const isDm = (await this.client.getJoinedRoomMembers(roomId)).length <= 2
      const source: SessionSource = {
        platform: Platform.MATRIX,
        chatId: roomId,
        chatName: roomId,
        chatType: isDm ? 'dm' : 'group',
        userId: sender,
      }

      let mt = MessageType.DOCUMENT
      if (msgtype === 'm.image') mt = MessageType.PHOTO
      else if (msgtype === 'm.video') mt = MessageType.VIDEO
      else if (msgtype === 'm.audio') mt = MessageType.AUDIO

      const ev = createMessageEvent(body || httpUrl, source)
      ev.messageType = mt
      ev.messageId = eventId
      ev.mediaUrls = httpUrl ? [httpUrl] : []
      ev.mediaTypes = [mime]
      await this.handleMessage(ev)
    }
  }

  private mxcToHttp(mxc: string): string {
    if (!mxc.startsWith('mxc://')) return mxc
    const rest = mxc.slice('mxc://'.length)
    const base = (this.client?.homeserverUrl || '').replace(/\/$/, '')
    return `${base}/_matrix/client/v1/media/download/${rest}`
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.stop()
      } catch {}
      this.client = null
    }
    this.userId = null
    this.markDisconnected()
  }

  async send(
    chatId: string,
    content: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' }

    const filePath = metadata?.filePath as string | undefined
    if (filePath && fs.existsSync(filePath)) {
      return this.sendFileUpload(chatId, filePath, replyTo, metadata)
    }

    const formatted = this.formatMessage(content)
    const chunks = this.truncateMessage(formatted, this.MAX_MESSAGE_LENGTH)
    const threadId = metadata?.thread_id as string | undefined

    let lastId: string | undefined
    for (const chunk of chunks) {
      const body: Record<string, unknown> = {
        msgtype: 'm.text',
        body: chunk,
      }
      const html = this.markdownToHtml(chunk)
      if (html && html !== chunk) {
        body.format = 'org.matrix.custom.html'
        body.formatted_body = html
      }
      const relates: Record<string, unknown> = {}
      if (replyTo) relates['m.in_reply_to'] = { event_id: replyTo }
      if (threadId) {
        relates['rel_type'] = 'm.thread'
        relates.event_id = threadId
        relates['is_falling_back'] = true
      }
      if (Object.keys(relates).length) body['m.relates_to'] = relates

      try {
        lastId = await this.client.sendMessage(chatId, body)
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }
    return { success: true, messageId: lastId }
  }

  private async sendFileUpload(
    chatId: string,
    filePath: string,
    replyTo?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SendResult> {
    const data = fs.readFileSync(filePath)
    const fname = path.basename(filePath)
    const mime =
      metadata?.mimeType?.toString() ||
      (path.extname(fname) === '.png' ? 'image/png' : 'application/octet-stream')
    const msgtype = mime.startsWith('image/') ? 'm.image' : 'm.file'

    const uri = await this.client.uploadContent(data, mime, fname)
    const content: Record<string, unknown> = {
      msgtype,
      body: fname,
      url: uri,
      info: { mimetype: mime, size: data.length },
    }
    const threadId = metadata?.thread_id as string | undefined
    const relates: Record<string, unknown> = {}
    if (replyTo) relates['m.in_reply_to'] = { event_id: replyTo }
    if (threadId) {
      relates['rel_type'] = 'm.thread'
      relates.event_id = threadId
      relates['is_falling_back'] = true
    }
    if (Object.keys(relates).length) content['m.relates_to'] = relates

    try {
      const id = await this.client.sendMessage(chatId, content)
      return { success: true, messageId: id }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' }
    const formatted = this.formatMessage(content)
    const html = this.markdownToHtml(formatted)
    const newContent: Record<string, unknown> = {
      msgtype: 'm.text',
      body: formatted,
    }
    if (html && html !== formatted) {
      newContent.format = 'org.matrix.custom.html'
      newContent.formatted_body = html
    }
    const msg: Record<string, unknown> = {
      msgtype: 'm.text',
      body: `* ${formatted}`,
      'm.new_content': newContent,
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: messageId,
      },
    }
    if (html && html !== formatted) {
      msg.format = 'org.matrix.custom.html'
      msg.formatted_body = `* ${html}`
    }
    try {
      const id = await this.client.sendEvent(chatId, 'm.room.message', msg)
      return { success: true, messageId: id }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    if (!this.client) return { name: chatId, type: 'group' }
    try {
      const ev = await this.client.getRoomStateEvent(chatId, 'm.room.name', '')
      const name = ev?.name || chatId
      const members = await this.client.getJoinedRoomMembers(chatId)
      return { name, type: members.length <= 2 ? 'dm' : 'group' }
    } catch {
      return { name: chatId, type: 'group' }
    }
  }

  formatMessage(content: string): string {
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2')
  }

  private markdownToHtml(text: string): string {
    if (!text) return text
    let h = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    h = h.replace(/\n/g, '<br/>')
    return h
  }
}
