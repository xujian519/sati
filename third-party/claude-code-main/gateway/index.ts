/**
 * Gateway entry point.
 *
 * Starts the messaging gateway alongside the existing proxy.
 * Can be imported and started programmatically, or run standalone.
 *
 * Usage:
 *   import { startGateway } from './gateway'
 *   const runner = await startGateway()
 *
 *   // Or standalone:
 *   bun run gateway/index.ts
 */

import { GatewayRunner } from './runner'
import { loadGatewayConfig, getConnectedPlatforms } from './config'

export { GatewayRunner } from './runner'
export { loadGatewayConfig, getConnectedPlatforms } from './config'
export { SessionStore, buildSessionKey, buildSessionContextPrompt } from './session'
export { GatewayStreamConsumer } from './stream-consumer'
export { DeliveryRouter, parseDeliveryTarget } from './delivery'
export { BasePlatformAdapter } from './platforms/base'
export * from './types'

let _runner: GatewayRunner | null = null

export async function startGateway(): Promise<GatewayRunner> {
  if (_runner) return _runner

  const config = loadGatewayConfig()
  const platforms = getConnectedPlatforms(config)

  if (platforms.length === 0) {
    console.log('[gateway] No platforms configured — gateway disabled')
    console.log('[gateway] Set platform env vars (e.g. TELEGRAM_BOT_TOKEN) to enable')
    const runner = new GatewayRunner(config)
    _runner = runner
    return runner
  }

  const runner = new GatewayRunner(config)
  await runner.start()
  _runner = runner
  return runner
}

export async function stopGateway(): Promise<void> {
  if (_runner) {
    await _runner.stop()
    _runner = null
  }
}

export function getGatewayRunner(): GatewayRunner | null {
  return _runner
}

// ─── Standalone mode ───

if (import.meta.main) {
  console.log('[gateway] Starting in standalone mode...')

  const runner = await startGateway()

  process.on('SIGINT', async () => {
    console.log('\n[gateway] Shutting down...')
    await stopGateway()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await stopGateway()
    process.exit(0)
  })

  // Keep alive
  await new Promise(() => {})
}
