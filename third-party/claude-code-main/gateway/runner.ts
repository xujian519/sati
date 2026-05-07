/**
 * Gateway runner — manages the lifecycle of all platform adapters,
 * handles incoming messages, routes to Claude Code via Agent SDK,
 * and delivers responses back to chat platforms.
 *
 * This is the core orchestrator ported from hermes-agent gateway/run.py.
 * Uses @anthropic-ai/claude-agent-sdk to invoke Claude Code with full
 * tool-use capabilities (file ops, shell, search, etc.).
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

import type {
  GatewayConfig,
  MessageEvent,
  SessionSource,
  PlatformConfig,
  SendResult,
  HomeChannel,
} from './types'
import { Platform, MessageType } from './types'
import { loadGatewayConfig, getConnectedPlatforms } from './config'
import { SessionStore, buildSessionKey, buildSessionContextPrompt } from './session'
import { GatewayStreamConsumer, type StreamConsumerConfig } from './stream-consumer'
import { DeliveryRouter, parseDeliveryTarget } from './delivery'
import { BasePlatformAdapter } from './platforms/base'
import { listProjects, formatProjectListText, buildFeishuProjectCard, type ProjectInfo } from './projects'

// ─── Claude Agent SDK ───

const require = createRequire(import.meta.url)
let sdkQuery: any
try {
  const sdk = require('@anthropic-ai/claude-agent-sdk')
  sdkQuery = sdk.query
  console.log('[gateway] Claude Agent SDK loaded')
} catch {
  console.warn('[gateway] @anthropic-ai/claude-agent-sdk not available, falling back to raw API')
}

function getGeneralCwd(): string {
  const dir = join(homedir(), 'Claude', 'general')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getClaudeCodeSpawnOptions(): { pathToClaudeCodeExecutable: string; executable: string; executableArgs: string[] } | null {
  const gatewayDir = dirname(new URL(import.meta.url).pathname)
  const ccRoot = resolve(gatewayDir, '..')

  const cli = join(ccRoot, 'src', 'entrypoints', 'cli.tsx')
  const preload = join(ccRoot, 'preload.ts')

  if (!existsSync(cli)) return null

  const executableArgs = ['run']
  if (existsSync(preload)) {
    executableArgs.push('--preload', preload)
  }

  console.log(`[gateway] Claude Code local tree: ${ccRoot}`)
  return {
    pathToClaudeCodeExecutable: cli,
    executable: 'bun',
    executableArgs,
  }
}

// ─── Gateway runner ───

interface AdapterEntry {
  platform: Platform
  adapter: BasePlatformAdapter
}

export class GatewayRunner {
  config: GatewayConfig
  adapters = new Map<Platform, BasePlatformAdapter>()
  sessionStore: SessionStore
  deliveryRouter: DeliveryRouter

  private running = false
  private failedPlatforms = new Map<Platform, { config: PlatformConfig; retries: number }>()
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private runningAgents = new Set<string>()

  constructor(config?: GatewayConfig) {
    this.config = config ?? loadGatewayConfig()
    this.sessionStore = new SessionStore(this.config.sessionsDir, this.config)
    this.deliveryRouter = new DeliveryRouter(this.config, this.adapters)
  }

  async start(): Promise<void> {
    console.log('[gateway] Starting gateway...')
    const connectedPlatforms = getConnectedPlatforms(this.config)

    if (connectedPlatforms.length === 0) {
      console.warn('[gateway] No platforms configured. Set environment variables to enable platforms.')
      return
    }

    console.log(`[gateway] Enabled platforms: ${connectedPlatforms.join(', ')}`)

    for (const platform of connectedPlatforms) {
      const platformConfig = this.config.platforms[platform]
      if (!platformConfig) continue

      const adapter = await this.createAdapter(platform, platformConfig)
      if (!adapter) {
        console.warn(`[gateway] Failed to create adapter for ${platform}`)
        this.failedPlatforms.set(platform, { config: platformConfig, retries: 0 })
        continue
      }

      adapter.setMessageHandler((event) => this.handleMessage(event))
      adapter.setFatalErrorHandler(async (a) => this.handleFatalError(a))

      try {
        const ok = await adapter.connect()
        if (ok) {
          this.adapters.set(platform, adapter)
          console.log(`[gateway] ${adapter.name} connected successfully`)
        } else {
          console.warn(`[gateway] ${adapter.name} failed to connect`)
          this.failedPlatforms.set(platform, { config: platformConfig, retries: 0 })
        }
      } catch (err) {
        console.error(`[gateway] ${adapter.name} connection error:`, err)
        this.failedPlatforms.set(platform, { config: platformConfig, retries: 0 })
      }
    }

    this.running = true

    // Start reconnection watcher for failed platforms
    if (this.failedPlatforms.size > 0) {
      this.startReconnectWatcher()
    }

    console.log(`[gateway] Gateway started with ${this.adapters.size} adapter(s)`)
  }

  async stop(): Promise<void> {
    console.log('[gateway] Stopping gateway...')
    this.running = false

    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const disconnects = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.disconnect()
      } catch (err) {
        console.error(`[gateway] Error disconnecting ${adapter.name}:`, err)
      }
    })
    await Promise.all(disconnects)
    this.adapters.clear()
    this.sessionStore.close()
    console.log('[gateway] Gateway stopped')
  }

  // ─── Adapter factory ───

  private async createAdapter(
    platform: Platform,
    config: PlatformConfig,
  ): Promise<BasePlatformAdapter | null> {
    // Inject global session isolation settings into adapter config
    config.extra.group_sessions_per_user ??= this.config.groupSessionsPerUser
    config.extra.thread_sessions_per_user ??= this.config.threadSessionsPerUser

    try {
      switch (platform) {
        case Platform.TELEGRAM: {
          const { TelegramAdapter } = await import('./platforms/telegram')
          return new TelegramAdapter(config)
        }
        case Platform.DISCORD: {
          const { DiscordAdapter } = await import('./platforms/discord')
          return new DiscordAdapter(config)
        }
        case Platform.SLACK: {
          const { SlackAdapter } = await import('./platforms/slack')
          return new SlackAdapter(config)
        }
        case Platform.FEISHU: {
          const { FeishuAdapter } = await import('./platforms/feishu')
          return new FeishuAdapter(config)
        }
        case Platform.WECOM: {
          const { WeComAdapter } = await import('./platforms/wecom')
          return new WeComAdapter(config)
        }
        case Platform.WECOM_CALLBACK: {
          const { WeComCallbackAdapter } = await import('./platforms/wecom-callback')
          return new WeComCallbackAdapter(config)
        }
        case Platform.DINGTALK: {
          const { DingTalkAdapter } = await import('./platforms/dingtalk')
          return new DingTalkAdapter(config)
        }
        case Platform.WEIXIN: {
          const { WeixinAdapter } = await import('./platforms/weixin')
          return new WeixinAdapter(config)
        }
        case Platform.WHATSAPP: {
          const { WhatsAppAdapter } = await import('./platforms/whatsapp')
          return new WhatsAppAdapter(config)
        }
        case Platform.SIGNAL: {
          const { SignalAdapter } = await import('./platforms/signal')
          return new SignalAdapter(config)
        }
        case Platform.MATRIX: {
          const { MatrixAdapter } = await import('./platforms/matrix')
          return new MatrixAdapter(config)
        }
        case Platform.MATTERMOST: {
          const { MattermostAdapter } = await import('./platforms/mattermost')
          return new MattermostAdapter(config)
        }
        case Platform.EMAIL: {
          const { EmailAdapter } = await import('./platforms/email')
          return new EmailAdapter(config)
        }
        case Platform.SMS: {
          const { SmsAdapter } = await import('./platforms/sms')
          return new SmsAdapter(config)
        }
        case Platform.HOMEASSISTANT: {
          const { HomeAssistantAdapter } = await import('./platforms/homeassistant')
          return new HomeAssistantAdapter(config)
        }
        case Platform.API_SERVER: {
          const { APIServerAdapter } = await import('./platforms/api-server')
          return new APIServerAdapter(config)
        }
        case Platform.WEBHOOK: {
          const { WebhookAdapter } = await import('./platforms/webhook')
          return new WebhookAdapter(config)
        }
        case Platform.BLUEBUBBLES: {
          const { BlueBubblesAdapter } = await import('./platforms/bluebubbles')
          return new BlueBubblesAdapter(config)
        }
        default:
          return null
      }
    } catch (err) {
      console.error(`[gateway] Failed to import adapter for ${platform}:`, err)
      return null
    }
  }

  // ─── Message handling ───

  private async handleMessage(event: MessageEvent): Promise<string | undefined> {
    console.log(`[gateway] handleMessage called: platform=${event.source.platform}, text="${event.text.slice(0, 50)}"`)
    const source = event.source
    const sessionKey = buildSessionKey(
      source,
      this.config.groupSessionsPerUser,
      this.config.threadSessionsPerUser,
    )

    // Authorization check
    if (!event.internal && !this.isUserAuthorized(source)) {
      console.log(`[gateway] Unauthorized message from ${source.userId} on ${source.platform}`)
      return undefined
    }
    console.log(`[gateway] User authorized, sessionKey=${sessionKey}`)

    // Check for slash commands
    if (event.text.startsWith('/')) {
      const command = event.text.split(/\s+/, 1)[0].slice(1).toLowerCase()
      if (this.config.resetTriggers.includes(`/${command}`)) {
        this.sessionStore.getOrCreateSession(source, true)
        const userProject = this.sessionStore.getUserProjectState(source.userId, source.platform)
        const projectKey = userProject.project?.name ?? 'general'
        this.sessionStore.clearSdkSession(source.userId, source.platform, projectKey)
        console.log(`[gateway] Session reset: cleared SDK session for projectKey=${projectKey}`)
        const adapter = this.adapters.get(source.platform)
        if (adapter) {
          await adapter.send(source.chatId, '🔄 Session reset. Starting fresh.')
        }
        return undefined
      }
      if (command === 'stop') {
        this.sessionStore.suspendSession(sessionKey)
        return '⏹ Session stopped.'
      }
    }

    // ─── Project commands ───
    const adapter = this.adapters.get(source.platform)
    const projectResult = await this.handleProjectCommand(event, adapter)
    if (projectResult !== null) return projectResult

    // Check if already processing a message for this session
    if (this.runningAgents.has(sessionKey)) {
      console.log(`[gateway] Session ${sessionKey} already active, queuing message`)
      return undefined
    }

    return this.runAgent(event, sessionKey)
  }

  private async runAgent(event: MessageEvent, sessionKey: string): Promise<string | undefined> {
    console.log(`[gateway] runAgent called for sessionKey=${sessionKey}`)
    const source = event.source
    const adapter = this.adapters.get(source.platform)
    if (!adapter) {
      console.log(`[gateway] No adapter found for platform ${source.platform}`)
      return undefined
    }

    this.runningAgents.add(sessionKey)

    try {
      const session = this.sessionStore.getOrCreateSession(source)
      console.log(`[gateway] Session: ${session.sessionId}`)

      await adapter.sendTyping(source.chatId)

      if (sdkQuery) {
        return await this.runWithSDK(adapter, event, session.sessionId)
      }
      // Fallback: no SDK available
      return 'Claude Agent SDK not available. Install @anthropic-ai/claude-agent-sdk.'
    } catch (err) {
      console.error(`[gateway] Agent error for ${sessionKey}:`, err)
      return 'Sorry, an error occurred while processing your message.'
    } finally {
      this.runningAgents.delete(sessionKey)
      await adapter.stopTyping(source.chatId)
    }
  }

  private async runWithSDK(
    adapter: BasePlatformAdapter,
    event: MessageEvent,
    sessionId: string,
  ): Promise<string | undefined> {
    const useStreaming = adapter.supportsStreaming

    const metadata: Record<string, unknown> = {}
    if (event.source.threadId) metadata.thread_id = event.source.threadId

    let consumer: GatewayStreamConsumer | null = null
    let consumerPromise: Promise<void> | null = null

    if (useStreaming) {
      const streamConfig: StreamConsumerConfig = {
        editInterval: this.config.streaming.editInterval,
        bufferThreshold: this.config.streaming.bufferThreshold,
        cursor: this.config.streaming.cursor,
      }
      consumer = new GatewayStreamConsumer(
        adapter,
        event.source.chatId,
        streamConfig,
        Object.keys(metadata).length > 0 ? metadata : undefined,
      )
      consumerPromise = consumer.run()
    }

    try {
      const userProject = this.sessionStore.getUserProjectState(event.source.userId, event.source.platform)
      let projectCwd: string
      let projectKey: string

      if (userProject.project?.path) {
        if (!existsSync(userProject.project.path)) {
          console.warn(`[gateway] Project directory not found: ${userProject.project.path}, falling back to general`)
          this.sessionStore.clearUserProject(event.source.userId, event.source.platform)
          projectCwd = getGeneralCwd()
          projectKey = 'general'
        } else {
          projectCwd = userProject.project.path
          projectKey = userProject.project.name
        }
      } else {
        projectCwd = getGeneralCwd()
        projectKey = 'general'
      }
      console.log(`[gateway] SDK cwd: ${projectCwd} (projectKey=${projectKey})`)

      const savedSessionId = this.sessionStore.getSdkSessionId(event.source.userId, event.source.platform, projectKey)

      const sdkOptions: Record<string, unknown> = {
        permissionMode: 'bypassPermissions',
        tools: { type: 'preset', preset: 'claude_code' },
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
        includePartialMessages: true,
        persistSession: true,
        cwd: projectCwd,
        env: { ...process.env },
        appendSystemPrompt: [
          'You are running inside a messaging gateway (Feishu, Telegram, etc), not an interactive terminal.',
          'Ask clarifying questions directly in your text response — do NOT attempt to use structured question tools.',
          'You cannot enter plan mode. Provide plans inline in your response text.',
          'Complete multi-step operations in a single turn when possible — do not pause mid-task.',
        ].join('\n'),
      }

      if (savedSessionId) {
        sdkOptions.resume = savedSessionId
        console.log(`[gateway] Resuming SDK session: ${savedSessionId}`)
      }

      const spawnOpts = getClaudeCodeSpawnOptions()
      if (spawnOpts) {
        sdkOptions.pathToClaudeCodeExecutable = spawnOpts.pathToClaudeCodeExecutable
        sdkOptions.executable = spawnOpts.executable
        sdkOptions.executableArgs = spawnOpts.executableArgs
      }

      console.log(`[gateway] Starting Claude Code SDK query... (streaming=${useStreaming})`)
      const queryInstance = sdkQuery({
        prompt: event.text,
        options: sdkOptions,
      })

      let fullResponse = ''
      let capturedSessionId: string | null = null

      for await (const message of queryInstance) {
        const mtype = message.type

        if (mtype === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              console.log(`[gateway]   🔧 Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`)
            }
            if (block.type === 'text' && block.text) {
              const newText = block.text.slice(fullResponse.length)
              if (newText) {
                consumer?.onDelta(newText)
                fullResponse = block.text
              }
            }
          }
        }

        if (mtype === 'stream_event') {
          const ev = (message as any).event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            consumer?.onDelta(ev.delta.text)
            fullResponse += ev.delta.text
          }
        }

        if (mtype === 'user' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_result') {
              const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              console.log(`[gateway]   📋 Tool result (${block.tool_use_id?.slice(0, 12)}): ${resultStr?.slice(0, 300)}`)
            }
          }
        }

        if (mtype === 'result') {
          const resultText = message.result ?? ''
          if (resultText && resultText !== fullResponse) {
            const delta = resultText.slice(fullResponse.length)
            if (delta) consumer?.onDelta(delta)
            fullResponse = resultText
          }
          capturedSessionId = (message as any).session_id ?? null
          console.log(`[gateway] SDK query complete, result length=${fullResponse.length}, session_id=${capturedSessionId}`)
        }
      }

      if (capturedSessionId) {
        this.sessionStore.setSdkSessionId(event.source.userId, event.source.platform, projectKey, capturedSessionId)
      }

      if (consumer) {
        consumer.finish()
        await consumerPromise
      }

      if (consumer?.finalResponseSent || consumer?.alreadySent) {
        return undefined
      }
      return fullResponse || undefined
    } catch (err) {
      if (consumer) {
        consumer.finish()
        await consumerPromise
      }
      throw err
    }
  }

  // ─── Project selection ───

  private useProjectCards(): boolean {
    const v = process.env.FEISHU_PROJECT_CARD ?? ''
    return v === 'true' || v === '1'
  }

  /**
   * Handle /projects, /pwd, and numeric project selection.
   * Returns a string (handled) or null (not a project command, continue to agent).
   * Most responses are delegated to CC by rewriting event.text.
   */
  private async handleProjectCommand(
    event: MessageEvent,
    adapter: BasePlatformAdapter | undefined,
  ): Promise<string | null> {
    const source = event.source
    const text = event.text.trim()
    const state = this.sessionStore.getUserProjectState(source.userId, source.platform)

    // Card action: direct project selection from interactive button
    const cardSelection = (event as any)._projectSelection as { name: string; path: string } | undefined
    if (cardSelection) {
      if (!existsSync(cardSelection.path)) {
        event.text = `[系统消息] 用户尝试切换到项目 "${cardSelection.name}"，但目录 ${cardSelection.path} 不存在。请告知用户并建议使用 /projects 重新选择。`
        return null
      }
      this.sessionStore.setUserProject(source.userId, source.platform, cardSelection.name, cardSelection.path)
      console.log(`[gateway] Card selection: user ${source.userId} -> ${cardSelection.name} (${cardSelection.path})`)
      event.text = `[系统消息] 用户已切换到项目 "${cardSelection.name}"，工作目录: ${cardSelection.path}。请简短确认。`
      return null
    }

    // /projects — show project picker (only command that sends directly)
    if (text === '/projects') {
      const projects = await listProjects()
      console.log(`[gateway] /projects: found ${projects.length} projects`)

      if (adapter && this.useProjectCards() && source.platform === Platform.FEISHU) {
        const card = buildFeishuProjectCard(projects)
        await adapter.send(source.chatId, '', undefined, {
          msgType: 'interactive',
          card,
        })
      } else if (adapter) {
        await adapter.send(source.chatId, formatProjectListText(projects))
      }

      this.sessionStore.setPendingProjectSelection(source.userId, source.platform, true, projects)
      return ''
    }

    // /pwd — delegate to CC with project context
    if (text === '/pwd') {
      if (state.project) {
        event.text = `[系统消息] 用户想知道当前项目信息。当前项目: "${state.project.name}"，工作目录: ${state.project.path}。请告知用户。`
      } else {
        event.text = `[系统消息] 用户想知道当前项目信息。当前未选择项目，使用默认工作目录 ${process.cwd()}。可以发送 /projects 选择项目。请告知用户。`
      }
      return null
    }

    // Numeric selection when pending — set project, delegate confirmation to CC
    if (state.pendingSelection && /^\d+$/.test(text)) {
      const index = parseInt(text, 10) - 1
      const projects = state.cachedProjects
      if (!projects || index < 0 || index >= projects.length) {
        event.text = `[系统消息] 用户输入了编号 ${text}，但有效范围是 1-${projects?.length ?? '?'}。请提示用户输入正确编号。`
        this.sessionStore.setPendingProjectSelection(source.userId, source.platform, false)
        return null
      }

      const selected = projects[index]

      if (!existsSync(selected.path)) {
        this.sessionStore.setPendingProjectSelection(source.userId, source.platform, false)
        event.text = `[系统消息] 用户选择了项目 "${selected.displayName}"，但目录 ${selected.path} 不存在。请告知用户并建议重新选择。`
        return null
      }

      this.sessionStore.setUserProject(source.userId, source.platform, selected.name, selected.path)
      this.sessionStore.setPendingProjectSelection(source.userId, source.platform, false)
      console.log(`[gateway] User ${source.userId} selected project: ${selected.name} -> ${selected.path}`)
      event.text = `[系统消息] 用户已成功切换到项目 "${selected.displayName}"，工作目录: ${selected.path}。请简短确认并告知用户可以开始提问了。`
      return null
    }

    // If pending but not a number, clear pending state and fall through to agent
    if (state.pendingSelection) {
      this.sessionStore.setPendingProjectSelection(source.userId, source.platform, false)
    }

    return null
  }

  // ─── Authorization ───

  private isUserAuthorized(source: SessionSource): boolean {
    const platformConfig = this.config.platforms[source.platform]
    if (!platformConfig) return false

    // System platforms skip user auth
    if (
      source.platform === Platform.HOMEASSISTANT ||
      source.platform === Platform.WEBHOOK
    ) {
      return true
    }

    // Per-platform allow-all
    if (platformConfig.extra.allowAllUsers) return true

    // Per-platform allowlist
    const allowedStr = platformConfig.extra.allowedUsers as string | undefined
    if (allowedStr && source.userId) {
      const allowed = allowedStr.split(',').map(s => s.trim())
      if (allowed.includes(source.userId)) return true
      if (source.userName && allowed.includes(source.userName)) return true
    }

    // Global allow-all
    if (platformConfig.extra.globalAllowAll) return true

    // Global allowlist
    const globalAllowed = platformConfig.extra.globalAllowedUsers as string | undefined
    if (globalAllowed && source.userId) {
      const allowed = globalAllowed.split(',').map(s => s.trim())
      if (allowed.includes(source.userId)) return true
    }

    return false
  }

  // ─── Streaming resolution ───

  private resolveStreamingSetting(platform: Platform): boolean {
    if (!this.config.streaming.enabled) return false
    if (this.config.streaming.transport === 'off') return false

    // Check if the adapter supports message editing
    const adapter = this.adapters.get(platform)
    if (!adapter) return false

    return true
  }

  // ─── Reconnection ───

  private startReconnectWatcher(): void {
    this.reconnectTimer = setInterval(async () => {
      if (!this.running) return

      for (const [platform, info] of this.failedPlatforms) {
        info.retries++
        const delay = Math.min(30, 2 ** Math.min(info.retries, 5))
        if (info.retries % delay !== 0) continue

        console.log(`[gateway] Attempting reconnect for ${platform} (attempt ${info.retries})`)
        const adapter = await this.createAdapter(platform, info.config)
        if (!adapter) continue

        adapter.setMessageHandler((event) => this.handleMessage(event))
        adapter.setFatalErrorHandler(async (a) => this.handleFatalError(a))

        try {
          const ok = await adapter.connect()
          if (ok) {
            this.adapters.set(platform, adapter)
            this.failedPlatforms.delete(platform)
            console.log(`[gateway] ${adapter.name} reconnected successfully`)
          }
        } catch (err) {
          console.error(`[gateway] ${adapter.name} reconnect failed:`, err)
        }
      }

      if (this.failedPlatforms.size === 0 && this.reconnectTimer) {
        clearInterval(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }, 10_000)
  }

  private async handleFatalError(adapter: BasePlatformAdapter): Promise<void> {
    console.error(
      `[gateway] Fatal error on ${adapter.name}: ${adapter.fatalErrorMessage}`,
    )
    if (adapter.fatalErrorRetryable) {
      const config = this.config.platforms[adapter.platform]
      if (config) {
        this.failedPlatforms.set(adapter.platform, { config, retries: 0 })
        this.adapters.delete(adapter.platform)
        if (!this.reconnectTimer) this.startReconnectWatcher()
      }
    }
  }
}
