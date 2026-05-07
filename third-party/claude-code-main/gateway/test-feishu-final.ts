#!/usr/bin/env bun
/**
 * Feishu final test — single stable WebSocket connection.
 * Waits 5s after connect to let Feishu stabilize before printing ready.
 * Points to real proxy backend for LLM replies.
 */

const APP_ID = 'cli_a917a14208b99bde'
const APP_SECRET = 'nvWIkwu7qt5ejof68qUMJgxOLLlhzrSV'
const PROXY_PORT = process.env.PROXY_PORT || '18080'
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`

// Verify proxy
const health = await fetch(`${PROXY_URL}/health`).catch(() => null)
if (!health?.ok) {
  console.error(`Proxy not reachable at ${PROXY_URL}`)
  process.exit(1)
}
console.log(`✓ Proxy alive at ${PROXY_URL}`)

// Set env before importing gateway modules
process.env.OPENAI_BASE_URL = PROXY_URL
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'from-proxy'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'from-proxy'
process.env.FEISHU_APP_ID = APP_ID
process.env.FEISHU_APP_SECRET = APP_SECRET
process.env.GATEWAY_ALLOW_ALL_USERS = 'true'

// Clear old sessions
const { rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { getGatewayHome } = await import('./config')
try {
  const sessionsDir = join(getGatewayHome(), 'sessions')
  rmSync(join(sessionsDir, 'sessions.db'), { force: true })
  rmSync(join(sessionsDir, 'sessions.json'), { force: true })
  console.log('✓ Session data cleared')
} catch {}

const { GatewayRunner } = await import('./runner')
const { loadGatewayConfig } = await import('./config')

const config = loadGatewayConfig()
config.streaming.enabled = true

const runner = new GatewayRunner(config)
await runner.start()

const feishu = runner.adapters.get('feishu' as any)
if (!feishu) {
  console.error('✗ Feishu adapter not connected')
  await runner.stop()
  process.exit(1)
}

console.log(`✓ Feishu connected, upstream: ${PROXY_URL}`)
console.log()
console.log('等待5秒让飞书 WebSocket 稳定...')
await new Promise(r => setTimeout(r, 5000))
console.log()
console.log('▶ 准备就绪！给飞书 Bot 发消息试试。')
console.log('  Bot 会调用真实 LLM 回复到飞书。')
console.log('  按 Ctrl+C 停止。')
console.log()

process.on('SIGINT', async () => {
  console.log('\n停止中...')
  await runner.stop()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await runner.stop()
  process.exit(0)
})

await new Promise(() => {})
