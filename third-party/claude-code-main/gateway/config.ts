/**
 * Gateway configuration loading and management.
 *
 * Loads configuration from:
 * 1. YAML config file ($GATEWAY_HOME/config.yaml, default ~/.claude/gateway)
 * 2. Environment variables (highest priority)
 * 3. Built-in defaults
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type {
  GatewayConfig,
  PlatformConfig,
  SessionResetPolicy,
  StreamingConfig,
  HomeChannel,
} from './types'
import {
  Platform,
  createDefaultGatewayConfig,
  createDefaultPlatformConfig,
  createDefaultResetPolicy,
  createDefaultStreamingConfig,
} from './types'

let yamlParse: ((str: string) => unknown) | null = null
try {
  yamlParse = require('yaml').parse
} catch {
  // yaml package not installed — YAML configs will be skipped
}

/**
 * Resolve the gateway home directory.
 *
 *   $GATEWAY_HOME (if set) → ~/.claude/gateway
 */
export function getGatewayHome(): string {
  return process.env.GATEWAY_HOME || join(homedir(), '.claude', 'gateway')
}

function coerceBool(value: unknown, defaultVal = true): boolean {
  if (value === undefined || value === null) return defaultVal
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(lower)) return true
    if (['false', '0', 'no', 'off'].includes(lower)) return false
    return defaultVal
  }
  return defaultVal
}

function parseResetPolicy(data: Record<string, unknown>): SessionResetPolicy {
  return {
    mode: (data.mode as SessionResetPolicy['mode']) ?? 'both',
    atHour: (data.at_hour as number) ?? 4,
    idleMinutes: (data.idle_minutes as number) ?? 1440,
    notify: (data.notify as boolean) ?? true,
    notifyExcludePlatforms:
      (data.notify_exclude_platforms as string[]) ?? ['api_server', 'webhook'],
  }
}

function parseStreamingConfig(data: Record<string, unknown>): StreamingConfig {
  if (!data) return createDefaultStreamingConfig()
  return {
    enabled: coerceBool(data.enabled, false),
    transport: (data.transport as StreamingConfig['transport']) ?? 'edit',
    editInterval: Number(data.edit_interval ?? 1.0),
    bufferThreshold: Number(data.buffer_threshold ?? 40),
    cursor: (data.cursor as string) ?? ' ▉',
  }
}

function parsePlatformConfig(data: Record<string, unknown>): PlatformConfig {
  const result = createDefaultPlatformConfig()
  if (!data) return result
  result.enabled = coerceBool(data.enabled, false)
  result.token = data.token as string | undefined
  result.apiKey = data.api_key as string | undefined
  result.replyToMode =
    (data.reply_to_mode as PlatformConfig['replyToMode']) ?? 'first'
  result.extra = (data.extra as Record<string, unknown>) ?? {}
  if (data.home_channel && typeof data.home_channel === 'object') {
    const hc = data.home_channel as Record<string, unknown>
    result.homeChannel = {
      platform: hc.platform as Platform,
      chatId: String(hc.chat_id ?? ''),
      name: (hc.name as string) ?? 'Home',
    }
  }
  return result
}

function ensurePlatform(
  config: GatewayConfig,
  platform: Platform,
): PlatformConfig {
  if (!config.platforms[platform]) {
    config.platforms[platform] = createDefaultPlatformConfig()
  }
  return config.platforms[platform]!
}

/**
 * Apply environment variable overrides to the gateway config.
 * Mirrors hermes-agent's _apply_env_overrides().
 */
function applyEnvOverrides(config: GatewayConfig): void {
  const env = process.env

  // Telegram
  if (env.TELEGRAM_BOT_TOKEN) {
    const p = ensurePlatform(config, Platform.TELEGRAM)
    p.enabled = true
    p.token = env.TELEGRAM_BOT_TOKEN
    if (env.TELEGRAM_HOME_CHANNEL) {
      p.homeChannel = {
        platform: Platform.TELEGRAM,
        chatId: env.TELEGRAM_HOME_CHANNEL,
        name: env.TELEGRAM_HOME_CHANNEL_NAME ?? 'Home',
      }
    }
    if (env.TELEGRAM_ALLOWED_USERS) p.extra.allowedUsers = env.TELEGRAM_ALLOWED_USERS
    if (env.TELEGRAM_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.TELEGRAM_ALLOW_ALL_USERS)
    if (env.TELEGRAM_WEBHOOK_URL) p.extra.webhookUrl = env.TELEGRAM_WEBHOOK_URL
    if (env.TELEGRAM_WEBHOOK_PORT) p.extra.webhookPort = Number(env.TELEGRAM_WEBHOOK_PORT)
  }

  // Discord
  if (env.DISCORD_BOT_TOKEN) {
    const p = ensurePlatform(config, Platform.DISCORD)
    p.enabled = true
    p.token = env.DISCORD_BOT_TOKEN
    if (env.DISCORD_HOME_CHANNEL) {
      p.homeChannel = {
        platform: Platform.DISCORD,
        chatId: env.DISCORD_HOME_CHANNEL,
        name: env.DISCORD_HOME_CHANNEL_NAME ?? 'Home',
      }
    }
    if (env.DISCORD_ALLOWED_USERS) p.extra.allowedUsers = env.DISCORD_ALLOWED_USERS
    if (env.DISCORD_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.DISCORD_ALLOW_ALL_USERS)
  }

  // Slack
  if (env.SLACK_BOT_TOKEN) {
    const p = ensurePlatform(config, Platform.SLACK)
    p.enabled = true
    p.token = env.SLACK_BOT_TOKEN
    if (env.SLACK_APP_TOKEN) p.extra.appToken = env.SLACK_APP_TOKEN
    if (env.SLACK_HOME_CHANNEL) {
      p.homeChannel = {
        platform: Platform.SLACK,
        chatId: env.SLACK_HOME_CHANNEL,
        name: env.SLACK_HOME_CHANNEL_NAME ?? 'Home',
      }
    }
    if (env.SLACK_ALLOWED_USERS) p.extra.allowedUsers = env.SLACK_ALLOWED_USERS
    if (env.SLACK_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.SLACK_ALLOW_ALL_USERS)
  }

  // 飞书 Feishu / Lark
  if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
    const p = ensurePlatform(config, Platform.FEISHU)
    p.enabled = true
    p.extra.appId = env.FEISHU_APP_ID
    p.extra.appSecret = env.FEISHU_APP_SECRET
    if (env.FEISHU_VERIFICATION_TOKEN) p.extra.verificationToken = env.FEISHU_VERIFICATION_TOKEN
    if (env.FEISHU_ENCRYPT_KEY) p.extra.encryptKey = env.FEISHU_ENCRYPT_KEY
    if (env.FEISHU_CONNECTION_MODE) p.extra.connectionMode = env.FEISHU_CONNECTION_MODE
    if (env.FEISHU_WEBHOOK_PORT) p.extra.webhookPort = Number(env.FEISHU_WEBHOOK_PORT)
    if (env.FEISHU_HOME_CHANNEL) {
      p.homeChannel = {
        platform: Platform.FEISHU,
        chatId: env.FEISHU_HOME_CHANNEL,
        name: env.FEISHU_HOME_CHANNEL_NAME ?? 'Home',
      }
    }
    if (env.FEISHU_ALLOWED_USERS) p.extra.allowedUsers = env.FEISHU_ALLOWED_USERS
    if (env.FEISHU_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.FEISHU_ALLOW_ALL_USERS)
  }

  // 企业微信 WeCom (AI Bot WebSocket)
  if (env.WECOM_BOT_ID && env.WECOM_BOT_SECRET) {
    const p = ensurePlatform(config, Platform.WECOM)
    p.enabled = true
    p.extra.botId = env.WECOM_BOT_ID
    p.extra.botSecret = env.WECOM_BOT_SECRET
    if (env.WECOM_ALLOWED_USERS) p.extra.allowedUsers = env.WECOM_ALLOWED_USERS
    if (env.WECOM_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.WECOM_ALLOW_ALL_USERS)
  }

  // 企业微信 WeCom Callback (HTTP callback self-built app)
  if (env.WECOM_CALLBACK_ENABLED) {
    const p = ensurePlatform(config, Platform.WECOM_CALLBACK)
    p.enabled = coerceBool(env.WECOM_CALLBACK_ENABLED)
    if (env.WECOM_CALLBACK_PORT) p.extra.port = Number(env.WECOM_CALLBACK_PORT)
    if (env.WECOM_CALLBACK_CORP_ID) p.extra.corpId = env.WECOM_CALLBACK_CORP_ID
    if (env.WECOM_CALLBACK_TOKEN) p.extra.callbackToken = env.WECOM_CALLBACK_TOKEN
    if (env.WECOM_CALLBACK_ENCODING_AES_KEY) p.extra.encodingAesKey = env.WECOM_CALLBACK_ENCODING_AES_KEY
  }

  // 钉钉 DingTalk
  if (env.DINGTALK_CLIENT_ID && env.DINGTALK_CLIENT_SECRET) {
    const p = ensurePlatform(config, Platform.DINGTALK)
    p.enabled = true
    p.extra.clientId = env.DINGTALK_CLIENT_ID
    p.extra.clientSecret = env.DINGTALK_CLIENT_SECRET
    if (env.DINGTALK_ALLOWED_USERS) p.extra.allowedUsers = env.DINGTALK_ALLOWED_USERS
    if (env.DINGTALK_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.DINGTALK_ALLOW_ALL_USERS)
  }

  // 微信 Weixin (personal WeChat via iLink)
  if (env.WEIXIN_TOKEN && env.WEIXIN_ACCOUNT_ID) {
    const p = ensurePlatform(config, Platform.WEIXIN)
    p.enabled = true
    p.token = env.WEIXIN_TOKEN
    p.extra.accountId = env.WEIXIN_ACCOUNT_ID
    if (env.WEIXIN_BASE_URL) p.extra.baseUrl = env.WEIXIN_BASE_URL
    if (env.WEIXIN_ALLOWED_USERS) p.extra.allowedUsers = env.WEIXIN_ALLOWED_USERS
    if (env.WEIXIN_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.WEIXIN_ALLOW_ALL_USERS)
  }

  // WhatsApp
  if (coerceBool(env.WHATSAPP_ENABLED, false)) {
    const p = ensurePlatform(config, Platform.WHATSAPP)
    p.enabled = true
    if (env.WHATSAPP_ALLOWED_USERS) p.extra.allowedUsers = env.WHATSAPP_ALLOWED_USERS
    if (env.WHATSAPP_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.WHATSAPP_ALLOW_ALL_USERS)
  }

  // Signal
  if (env.SIGNAL_HTTP_URL && env.SIGNAL_ACCOUNT) {
    const p = ensurePlatform(config, Platform.SIGNAL)
    p.enabled = true
    p.extra.httpUrl = env.SIGNAL_HTTP_URL
    p.extra.account = env.SIGNAL_ACCOUNT
    if (env.SIGNAL_ALLOWED_USERS) p.extra.allowedUsers = env.SIGNAL_ALLOWED_USERS
    if (env.SIGNAL_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.SIGNAL_ALLOW_ALL_USERS)
  }

  // Matrix
  if (env.MATRIX_HOMESERVER && (env.MATRIX_ACCESS_TOKEN || env.MATRIX_PASSWORD)) {
    const p = ensurePlatform(config, Platform.MATRIX)
    p.enabled = true
    p.extra.homeserver = env.MATRIX_HOMESERVER
    if (env.MATRIX_ACCESS_TOKEN) p.token = env.MATRIX_ACCESS_TOKEN
    if (env.MATRIX_USER_ID) p.extra.userId = env.MATRIX_USER_ID
    if (env.MATRIX_PASSWORD) p.extra.password = env.MATRIX_PASSWORD
    if (env.MATRIX_ALLOWED_USERS) p.extra.allowedUsers = env.MATRIX_ALLOWED_USERS
    if (env.MATRIX_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.MATRIX_ALLOW_ALL_USERS)
  }

  // Mattermost
  if (env.MATTERMOST_TOKEN && env.MATTERMOST_URL) {
    const p = ensurePlatform(config, Platform.MATTERMOST)
    p.enabled = true
    p.token = env.MATTERMOST_TOKEN
    p.extra.url = env.MATTERMOST_URL
    if (env.MATTERMOST_ALLOWED_USERS) p.extra.allowedUsers = env.MATTERMOST_ALLOWED_USERS
    if (env.MATTERMOST_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.MATTERMOST_ALLOW_ALL_USERS)
  }

  // Email
  if (env.EMAIL_ADDRESS && env.EMAIL_IMAP_HOST && env.EMAIL_SMTP_HOST) {
    const p = ensurePlatform(config, Platform.EMAIL)
    p.enabled = true
    p.extra.address = env.EMAIL_ADDRESS
    p.extra.password = env.EMAIL_PASSWORD
    p.extra.imapHost = env.EMAIL_IMAP_HOST
    p.extra.smtpHost = env.EMAIL_SMTP_HOST
    if (env.EMAIL_IMAP_PORT) p.extra.imapPort = Number(env.EMAIL_IMAP_PORT)
    if (env.EMAIL_SMTP_PORT) p.extra.smtpPort = Number(env.EMAIL_SMTP_PORT)
    if (env.EMAIL_ALLOWED_USERS) p.extra.allowedUsers = env.EMAIL_ALLOWED_USERS
    if (env.EMAIL_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.EMAIL_ALLOW_ALL_USERS)
  }

  // SMS (Twilio)
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    const p = ensurePlatform(config, Platform.SMS)
    p.enabled = true
    p.apiKey = env.TWILIO_AUTH_TOKEN
    p.extra.accountSid = env.TWILIO_ACCOUNT_SID
    if (env.TWILIO_PHONE_NUMBER) p.extra.phoneNumber = env.TWILIO_PHONE_NUMBER
    if (env.SMS_WEBHOOK_PORT) p.extra.webhookPort = Number(env.SMS_WEBHOOK_PORT)
  }

  // Home Assistant
  if (env.HASS_TOKEN && env.HASS_URL) {
    const p = ensurePlatform(config, Platform.HOMEASSISTANT)
    p.enabled = true
    p.token = env.HASS_TOKEN
    p.extra.url = env.HASS_URL
  }

  // API Server
  if (coerceBool(env.API_SERVER_ENABLED, false)) {
    const p = ensurePlatform(config, Platform.API_SERVER)
    p.enabled = true
    if (env.API_SERVER_KEY) p.apiKey = env.API_SERVER_KEY
    if (env.API_SERVER_PORT) p.extra.port = Number(env.API_SERVER_PORT)
    if (env.API_SERVER_HOST) p.extra.host = env.API_SERVER_HOST
    if (env.API_SERVER_CORS_ORIGINS) p.extra.corsOrigins = env.API_SERVER_CORS_ORIGINS
  }

  // Webhook
  if (coerceBool(env.WEBHOOK_ENABLED, false)) {
    const p = ensurePlatform(config, Platform.WEBHOOK)
    p.enabled = true
    if (env.WEBHOOK_PORT) p.extra.port = Number(env.WEBHOOK_PORT)
    if (env.WEBHOOK_SECRET) p.extra.secret = env.WEBHOOK_SECRET
  }

  // BlueBubbles
  if (env.BLUEBUBBLES_SERVER_URL && env.BLUEBUBBLES_PASSWORD) {
    const p = ensurePlatform(config, Platform.BLUEBUBBLES)
    p.enabled = true
    p.extra.serverUrl = env.BLUEBUBBLES_SERVER_URL
    p.extra.password = env.BLUEBUBBLES_PASSWORD
    if (env.BLUEBUBBLES_ALLOWED_USERS) p.extra.allowedUsers = env.BLUEBUBBLES_ALLOWED_USERS
    if (env.BLUEBUBBLES_ALLOW_ALL_USERS) p.extra.allowAllUsers = coerceBool(env.BLUEBUBBLES_ALLOW_ALL_USERS)
  }

  // Global settings
  if (env.GATEWAY_ALLOW_ALL_USERS) {
    config.platforms[Platform.LOCAL] ??= createDefaultPlatformConfig()
    // Propagate to all platform extras
    for (const p of Object.values(config.platforms)) {
      if (p) (p as PlatformConfig).extra.globalAllowAll = coerceBool(env.GATEWAY_ALLOW_ALL_USERS)
    }
  }
  if (env.GATEWAY_ALLOWED_USERS) {
    for (const p of Object.values(config.platforms)) {
      if (p) (p as PlatformConfig).extra.globalAllowedUsers = env.GATEWAY_ALLOWED_USERS
    }
  }
}

/**
 * Load gateway configuration from YAML + env overrides.
 */
export function loadGatewayConfig(): GatewayConfig {
  const config = createDefaultGatewayConfig()
  const gatewayHome = getGatewayHome()
  // Session metadata lives inside the Claude Code projects tree so all
  // conversation state is rooted at a single location (~/.claude/projects/).
  config.sessionsDir = join(homedir(), '.claude', 'projects', '.gateway')

  // Load YAML config if available
  const yamlPath = join(gatewayHome, 'config.yaml')
  if (yamlParse && existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf-8')
      const data = yamlParse(raw) as Record<string, unknown> | null
      if (data && typeof data === 'object') {
        const gw = (data.gateway ?? data) as Record<string, unknown>

        // Platforms
        if (gw.platforms && typeof gw.platforms === 'object') {
          for (const [name, pdata] of Object.entries(gw.platforms as Record<string, unknown>)) {
            try {
              const platform = name as Platform
              if (Object.values(Platform).includes(platform)) {
                config.platforms[platform] = parsePlatformConfig(
                  pdata as Record<string, unknown>,
                )
              }
            } catch { /* skip unknown platforms */ }
          }
        }

        // Session reset
        if (gw.session_reset && typeof gw.session_reset === 'object') {
          const sr = gw.session_reset as Record<string, unknown>
          if (sr.default) config.defaultResetPolicy = parseResetPolicy(sr.default as Record<string, unknown>)
          if (sr.by_type && typeof sr.by_type === 'object') {
            for (const [k, v] of Object.entries(sr.by_type as Record<string, unknown>)) {
              config.resetByType[k] = parseResetPolicy(v as Record<string, unknown>)
            }
          }
          if (sr.by_platform && typeof sr.by_platform === 'object') {
            for (const [k, v] of Object.entries(sr.by_platform as Record<string, unknown>)) {
              const p = k as Platform
              if (Object.values(Platform).includes(p)) {
                config.resetByPlatform[p] = parseResetPolicy(v as Record<string, unknown>)
              }
            }
          }
        }

        // Streaming
        if (gw.streaming && typeof gw.streaming === 'object') {
          config.streaming = parseStreamingConfig(gw.streaming as Record<string, unknown>)
        }

        // Other flags
        if (gw.group_sessions_per_user !== undefined) {
          config.groupSessionsPerUser = coerceBool(gw.group_sessions_per_user, true)
        }
        if (gw.thread_sessions_per_user !== undefined) {
          config.threadSessionsPerUser = coerceBool(gw.thread_sessions_per_user, false)
        }
        if (gw.unauthorized_dm_behavior !== undefined) {
          const v = String(gw.unauthorized_dm_behavior).trim().toLowerCase()
          if (v === 'pair' || v === 'ignore') config.unauthorizedDmBehavior = v
        }
        if (gw.quick_commands && typeof gw.quick_commands === 'object') {
          config.quickCommands = gw.quick_commands as Record<string, unknown>
        }
      }
    } catch (err) {
      console.error(`[gateway] Warning: failed to load ${yamlPath}:`, err)
    }
  }

  // Env overrides take highest priority
  applyEnvOverrides(config)

  return config
}

/**
 * Get the list of platforms that are enabled and properly configured.
 */
export function getConnectedPlatforms(config: GatewayConfig): Platform[] {
  const connected: Platform[] = []
  for (const [platformStr, pConfig] of Object.entries(config.platforms)) {
    const platform = platformStr as Platform
    if (!pConfig || !pConfig.enabled) continue

    if (platform === Platform.WEIXIN) {
      if (pConfig.extra.accountId && (pConfig.token || pConfig.extra.token)) {
        connected.push(platform)
      }
      continue
    }

    if (pConfig.token || pConfig.apiKey) {
      connected.push(platform)
    } else if (platform === Platform.WHATSAPP) {
      connected.push(platform)
    } else if (platform === Platform.SIGNAL && pConfig.extra.httpUrl) {
      connected.push(platform)
    } else if (platform === Platform.EMAIL && pConfig.extra.address) {
      connected.push(platform)
    } else if (platform === Platform.SMS && process.env.TWILIO_ACCOUNT_SID) {
      connected.push(platform)
    } else if (platform === Platform.API_SERVER) {
      connected.push(platform)
    } else if (platform === Platform.WEBHOOK) {
      connected.push(platform)
    } else if (platform === Platform.FEISHU && pConfig.extra.appId) {
      connected.push(platform)
    } else if (platform === Platform.WECOM && pConfig.extra.botId) {
      connected.push(platform)
    } else if (platform === Platform.WECOM_CALLBACK && (pConfig.extra.corpId || pConfig.extra.apps)) {
      connected.push(platform)
    } else if (platform === Platform.BLUEBUBBLES && pConfig.extra.serverUrl && pConfig.extra.password) {
      connected.push(platform)
    }
  }
  return connected
}

/**
 * Get the reset policy for a given platform/session type combination.
 */
export function getResetPolicy(
  config: GatewayConfig,
  platform?: Platform,
  sessionType?: string,
): SessionResetPolicy {
  if (platform && config.resetByPlatform[platform]) {
    return config.resetByPlatform[platform]!
  }
  if (sessionType && config.resetByType[sessionType]) {
    return config.resetByType[sessionType]
  }
  return config.defaultResetPolicy
}
