#!/usr/bin/env bun
/**
 * Feishu live test — connects to real proxy.ts backend on :18080.
 * No mock upstream, real LLM replies.
 */

const FEISHU_APP_ID = 'cli_a917a14208b99bde'
const FEISHU_APP_SECRET = 'nvWIkwu7qt5ejof68qUMJgxOLLlhzrSV'
const PROXY_PORT = process.env.PROXY_PORT || '18080'
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`

console.log('═══════════════════════════════════')
console.log('  飞书 Live Test (real proxy backend)')
console.log('═══════════════════════════════════\n')

// Verify proxy is alive
try {
  const health = await fetch(`${PROXY_URL}/health`)
  if (!health.ok) throw new Error(`status ${health.status}`)
  console.log(`✓ Proxy alive at ${PROXY_URL}`)
} catch (err) {
  console.error(`✗ Proxy not reachable at ${PROXY_URL}: ${err}`)
  console.error('  Make sure proxy.ts is running (bash start.sh)')
  process.exit(1)
}

// Configure environment to point gateway at real proxy
process.env.OPENAI_BASE_URL = PROXY_URL
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'from-proxy'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'from-proxy'
process.env.FEISHU_APP_ID = FEISHU_APP_ID
process.env.FEISHU_APP_SECRET = FEISHU_APP_SECRET
process.env.GATEWAY_ALLOW_ALL_USERS = 'true'

const { GatewayRunner } = await import('./runner')
const { loadGatewayConfig } = await import('./config')

const config = loadGatewayConfig()
config.streaming.enabled = true

const runner = new GatewayRunner(config)
await runner.start()

const feishuAdapter = runner.adapters.get('feishu' as any)

console.log(`\n✓ Gateway started`)
console.log(`  Adapters: ${Array.from(runner.adapters.keys()).join(', ')}`)
console.log(`  Feishu: ${feishuAdapter ? '✓ connected' : '✗ not connected'}`)
console.log(`  Upstream: ${PROXY_URL} (real proxy)`)

if (feishuAdapter) {
  console.log('\n▶ 飞书 Bot 已启动，接真正的 CC 后端！')
  console.log('  给 Bot 发消息，Bot 会调用真实 LLM 回复。')
  console.log('  按 Ctrl+C 停止...\n')

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
} else {
  console.log('\n✗ Feishu adapter failed to connect')
  await runner.stop()
  process.exit(1)
}
