export { BasePlatformAdapter } from './base.js'

export {
  Platform,
  MessageType,
  type SessionSource,
  type MessageEvent,
  type SendResult,
  type ChatInfo,
  type PlatformConfig,
  type GatewayConfig,
  type HomeChannel,
  type SessionResetPolicy,
  type StreamingConfig,
  type SessionEntry,
  type MessageHandler,
  type DeliveryTarget,
  ProcessingOutcome,
  createDefaultResetPolicy,
  createDefaultStreamingConfig,
  createDefaultPlatformConfig,
  createDefaultGatewayConfig,
  createMessageEvent,
} from './types.js'

export { APIServerAdapter } from './api-server.js'
export { BlueBubblesAdapter } from './bluebubbles.js'
export { DingTalkAdapter, checkDingTalkRequirements } from './dingtalk.js'
export { DiscordAdapter } from './discord.js'
export { EmailAdapter } from './email.js'
export { FeishuAdapter, checkFeishuRequirements } from './feishu.js'
export { HomeAssistantAdapter } from './homeassistant.js'
export { MatrixAdapter } from './matrix.js'
export { MattermostAdapter } from './mattermost.js'
export { SignalAdapter } from './signal.js'
export { SlackAdapter } from './slack.js'
export { SmsAdapter } from './sms.js'
export { TelegramAdapter, checkTelegramRequirements } from './telegram.js'
export { WebhookAdapter } from './webhook.js'
export { WeComAdapter, checkWeComRequirements } from './wecom.js'
export { WeComCallbackAdapter } from './wecom-callback.js'
export { WeixinAdapter, decryptWeixinCdnBuffer } from './weixin.js'
export { WhatsAppAdapter } from './whatsapp.js'
