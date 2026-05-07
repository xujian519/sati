/**
 * Shared types for the messaging gateway.
 *
 * Ported from hermes-agent gateway/config.py, gateway/session.py,
 * and gateway/platforms/base.py.
 */

// ─── Platform enum ───

export enum Platform {
  LOCAL = 'local',
  TELEGRAM = 'telegram',
  DISCORD = 'discord',
  WHATSAPP = 'whatsapp',
  SLACK = 'slack',
  SIGNAL = 'signal',
  MATTERMOST = 'mattermost',
  MATRIX = 'matrix',
  HOMEASSISTANT = 'homeassistant',
  EMAIL = 'email',
  SMS = 'sms',
  DINGTALK = 'dingtalk',
  API_SERVER = 'api_server',
  WEBHOOK = 'webhook',
  FEISHU = 'feishu',
  WECOM = 'wecom',
  WECOM_CALLBACK = 'wecom_callback',
  WEIXIN = 'weixin',
  BLUEBUBBLES = 'bluebubbles',
}

// ─── Message types ───

export enum MessageType {
  TEXT = 'text',
  LOCATION = 'location',
  PHOTO = 'photo',
  VIDEO = 'video',
  AUDIO = 'audio',
  VOICE = 'voice',
  DOCUMENT = 'document',
  STICKER = 'sticker',
  COMMAND = 'command',
}

// ─── Session source ───

export interface SessionSource {
  platform: Platform
  chatId: string
  chatName?: string
  chatType: 'dm' | 'group' | 'channel' | 'thread'
  userId?: string
  userName?: string
  threadId?: string
  chatTopic?: string
  /** Alternative user ID (e.g. Signal UUID vs phone number) */
  userIdAlt?: string
  /** Alternative chat ID (e.g. Signal group internal ID) */
  chatIdAlt?: string
}

// ─── Message event ───

export interface MessageEvent {
  text: string
  messageType: MessageType
  source: SessionSource
  messageId?: string
  mediaUrls: string[]
  mediaTypes: string[]
  replyToMessageId?: string
  replyToText?: string
  /** Skills auto-loaded for topic/channel bindings */
  autoSkill?: string | string[]
  /** Synthetic events that bypass user auth checks */
  internal: boolean
  timestamp: Date
}

// ─── Send result ───

export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
  rawResponse?: unknown
  /** True for transient connection errors — base will retry automatically */
  retryable?: boolean
}

// ─── Chat info ───

export interface ChatInfo {
  name: string
  type: 'dm' | 'group' | 'channel'
  [key: string]: unknown
}

// ─── Home channel ───

export interface HomeChannel {
  platform: Platform
  chatId: string
  name: string
}

// ─── Session reset policy ───

export interface SessionResetPolicy {
  mode: 'daily' | 'idle' | 'both' | 'none'
  atHour: number
  idleMinutes: number
  notify: boolean
  notifyExcludePlatforms: string[]
}

// ─── Streaming config ───

export interface StreamingConfig {
  enabled: boolean
  transport: 'edit' | 'off'
  editInterval: number
  bufferThreshold: number
  cursor: string
}

// ─── Platform config ───

export interface PlatformConfig {
  enabled: boolean
  token?: string
  apiKey?: string
  homeChannel?: HomeChannel
  replyToMode: 'off' | 'first' | 'all'
  extra: Record<string, unknown>
}

// ─── Gateway config ───

export interface GatewayConfig {
  platforms: Partial<Record<Platform, PlatformConfig>>
  defaultResetPolicy: SessionResetPolicy
  resetByType: Record<string, SessionResetPolicy>
  resetByPlatform: Partial<Record<Platform, SessionResetPolicy>>
  resetTriggers: string[]
  quickCommands: Record<string, unknown>
  sessionsDir: string
  alwaysLogLocal: boolean
  sttEnabled: boolean
  groupSessionsPerUser: boolean
  threadSessionsPerUser: boolean
  unauthorizedDmBehavior: 'pair' | 'ignore'
  streaming: StreamingConfig
}

// ─── Session entry ───

export interface SessionEntry {
  sessionKey: string
  sessionId: string
  createdAt: Date
  updatedAt: Date
  origin?: SessionSource
  displayName?: string
  platform?: Platform
  chatType: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  lastPromptTokens: number
  estimatedCostUsd: number
  costStatus: string
  memoryFlushed: boolean
  suspended: boolean
  wasAutoReset: boolean
  autoResetReason?: string
  resetHadActivity: boolean
}

// ─── Message handler type ───

export type MessageHandler = (event: MessageEvent) => Promise<string | undefined>

// ─── Processing outcome ───

export enum ProcessingOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
  CANCELLED = 'cancelled',
}

// ─── Delivery target ───

export interface DeliveryTarget {
  platform: Platform
  chatId?: string
  threadId?: string
  isOrigin: boolean
  isExplicit: boolean
}

// ─── Helpers ───

export function createDefaultResetPolicy(): SessionResetPolicy {
  return {
    mode: 'both',
    atHour: 4,
    idleMinutes: 1440,
    notify: true,
    notifyExcludePlatforms: ['api_server', 'webhook'],
  }
}

export function createDefaultStreamingConfig(): StreamingConfig {
  return {
    enabled: false,
    transport: 'edit',
    editInterval: 1.0,
    bufferThreshold: 40,
    cursor: ' ▉',
  }
}

export function createDefaultPlatformConfig(): PlatformConfig {
  return {
    enabled: false,
    replyToMode: 'first',
    extra: {},
  }
}

export function createDefaultGatewayConfig(): GatewayConfig {
  return {
    platforms: {},
    defaultResetPolicy: createDefaultResetPolicy(),
    resetByType: {},
    resetByPlatform: {},
    resetTriggers: ['/new', '/reset'],
    quickCommands: {},
    sessionsDir: '',
    alwaysLogLocal: true,
    sttEnabled: true,
    groupSessionsPerUser: true,
    threadSessionsPerUser: false,
    unauthorizedDmBehavior: 'pair',
    streaming: createDefaultStreamingConfig(),
  }
}

export function createMessageEvent(text: string, source: SessionSource): MessageEvent {
  return {
    text,
    messageType: MessageType.TEXT,
    source,
    mediaUrls: [],
    mediaTypes: [],
    internal: false,
    timestamp: new Date(),
  }
}
