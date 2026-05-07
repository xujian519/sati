/**
 * Delivery routing for agent responses and cron job outputs.
 *
 * Routes messages to the appropriate destination based on:
 * - Explicit targets (e.g. "telegram:123456789")
 * - Platform home channels (e.g. "telegram" → home channel)
 * - Origin (back to where the message came from)
 * - Local (saved to files)
 *
 * Ported from hermes-agent gateway/delivery.py.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { GatewayConfig, DeliveryTarget, SessionSource } from './types'
import { Platform } from './types'
import type { BasePlatformAdapter } from './platforms/base'
import { getGatewayHome } from './config'

const MAX_PLATFORM_OUTPUT = 4000
const TRUNCATED_VISIBLE = 3800

function getOutputDir(): string {
  return join(getGatewayHome(), 'cron', 'output')
}

export function parseDeliveryTarget(
  target: string,
  origin?: SessionSource,
): DeliveryTarget {
  target = target.trim().toLowerCase()

  if (target === 'origin') {
    if (origin) {
      return {
        platform: origin.platform,
        chatId: origin.chatId,
        threadId: origin.threadId,
        isOrigin: true,
        isExplicit: false,
      }
    }
    return { platform: Platform.LOCAL, isOrigin: true, isExplicit: false }
  }

  if (target === 'local') {
    return { platform: Platform.LOCAL, isOrigin: false, isExplicit: false }
  }

  if (target.includes(':')) {
    const parts = target.split(':', 3)
    const platformStr = parts[0]
    const chatId = parts[1] || undefined
    const threadId = parts[2] || undefined
    try {
      const platform = platformStr as Platform
      if (Object.values(Platform).includes(platform)) {
        return { platform, chatId, threadId, isOrigin: false, isExplicit: true }
      }
    } catch { /* fall through */ }
    return { platform: Platform.LOCAL, isOrigin: false, isExplicit: false }
  }

  try {
    const platform = target as Platform
    if (Object.values(Platform).includes(platform)) {
      return { platform, isOrigin: false, isExplicit: false }
    }
  } catch { /* fall through */ }

  return { platform: Platform.LOCAL, isOrigin: false, isExplicit: false }
}

export function deliveryTargetToString(target: DeliveryTarget): string {
  if (target.isOrigin) return 'origin'
  if (target.platform === Platform.LOCAL) return 'local'
  if (target.chatId && target.threadId) {
    return `${target.platform}:${target.chatId}:${target.threadId}`
  }
  if (target.chatId) return `${target.platform}:${target.chatId}`
  return target.platform
}

export class DeliveryRouter {
  private config: GatewayConfig
  private adapters: Map<Platform, BasePlatformAdapter>
  private outputDir: string

  constructor(
    config: GatewayConfig,
    adapters: Map<Platform, BasePlatformAdapter>,
  ) {
    this.config = config
    this.adapters = adapters
    this.outputDir = getOutputDir()
  }

  async deliver(
    content: string,
    targets: DeliveryTarget[],
    jobId?: string,
    jobName?: string,
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, { success: boolean; result?: unknown; error?: string }>> {
    const results: Record<string, { success: boolean; result?: unknown; error?: string }> = {}

    for (const target of targets) {
      const key = deliveryTargetToString(target)
      try {
        if (target.platform === Platform.LOCAL) {
          const result = this.deliverLocal(content, jobId, jobName, metadata)
          results[key] = { success: true, result }
        } else {
          const result = await this.deliverToPlatform(target, content, metadata)
          results[key] = { success: true, result }
        }
      } catch (err) {
        results[key] = { success: false, error: String(err) }
      }
    }

    return results
  }

  private deliverLocal(
    content: string,
    jobId?: string,
    jobName?: string,
    metadata?: Record<string, unknown>,
  ): { path: string; timestamp: string } {
    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15)
    const subDir = jobId ?? 'misc'
    const outputPath = join(this.outputDir, subDir, `${timestamp}.md`)

    mkdirSync(dirname(outputPath), { recursive: true })

    const lines = [
      jobName ? `# ${jobName}` : '# Delivery Output',
      '',
      `**Timestamp:** ${now.toISOString()}`,
    ]
    if (jobId) lines.push(`**Job ID:** ${jobId}`)
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        lines.push(`**${k}:** ${v}`)
      }
    }
    lines.push('', '---', '', content)

    writeFileSync(outputPath, lines.join('\n'), 'utf-8')
    return { path: outputPath, timestamp }
  }

  private saveFullOutput(content: string, jobId: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
    const outDir = getOutputDir()
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, `${jobId}_${timestamp}.txt`)
    writeFileSync(path, content, 'utf-8')
    return path
  }

  private async deliverToPlatform(
    target: DeliveryTarget,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<unknown> {
    const adapter = this.adapters.get(target.platform)
    if (!adapter) throw new Error(`No adapter configured for ${target.platform}`)
    if (!target.chatId) throw new Error(`No chat ID for ${target.platform} delivery`)

    if (content.length > MAX_PLATFORM_OUTPUT) {
      const jobId = (metadata as Record<string, string>)?.job_id ?? 'unknown'
      const savedPath = this.saveFullOutput(content, jobId)
      console.log(
        `[delivery] Cron output truncated (${content.length} chars) — full output: ${savedPath}`,
      )
      content =
        content.slice(0, TRUNCATED_VISIBLE) +
        `\n\n... [truncated, full output saved to ${savedPath}]`
    }

    const sendMeta = { ...metadata }
    if (target.threadId && !sendMeta.thread_id) {
      sendMeta.thread_id = target.threadId
    }

    return adapter.send(target.chatId, content, undefined, sendMeta)
  }
}
