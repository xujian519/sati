#!/usr/bin/env bun
/**
 * Feishu (飞书) adapter integration test.
 *
 * Tests:
 *   1. Tenant access token acquisition
 *   2. Bot info retrieval
 *   3. WebSocket connection (if SDK installed)
 *   4. Full gateway startup with mock upstream → listens for real messages
 *
 * Usage:
 *   bun run gateway/test-feishu.ts
 */

const FEISHU_APP_ID = 'cli_a917a14208b99bde'
const FEISHU_APP_SECRET = 'nvWIkwu7qt5ejof68qUMJgxOLLlhzrSV'
const MOCK_PORT = 19998
const API_PORT = 18643

// ─── Step 1: Test token acquisition directly ───

console.log('═══════════════════════════════════════')
console.log('  飞书 (Feishu) Adapter Integration Test')
console.log('═══════════════════════════════════════\n')

console.log('── Step 1: Tenant Access Token ──')
let tenantToken: string | null = null
try {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  })
  const data = await res.json() as { code: number; tenant_access_token?: string; expire?: number; msg?: string }
  if (data.code === 0 && data.tenant_access_token) {
    tenantToken = data.tenant_access_token
    console.log(`  ✓ Token acquired (expires in ${data.expire}s)`)
    console.log(`    Token: ${tenantToken.slice(0, 20)}...`)
  } else {
    console.log(`  ✗ Token failed: code=${data.code}, msg=${data.msg}`)
    process.exit(1)
  }
} catch (err) {
  console.log(`  ✗ Token request error: ${err}`)
  process.exit(1)
}

// ─── Step 2: Get bot info ───

console.log('\n── Step 2: Bot Info ──')
try {
  const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { Authorization: `Bearer ${tenantToken}` },
  })
  const data = await res.json() as { code: number; bot?: { app_name?: string; open_id?: string } }
  if (data.code === 0 && data.bot) {
    console.log(`  ✓ Bot name: ${data.bot.app_name}`)
    console.log(`    Bot open_id: ${data.bot.open_id}`)
  } else {
    console.log(`  ⚠ Bot info unavailable (code=${data.code}) - this is OK for some app types`)
  }
} catch (err) {
  console.log(`  ⚠ Bot info request error: ${err}`)
}

// ─── Step 3: Check SDK availability ───

console.log('\n── Step 3: SDK Check ──')
let hasLarkSDK = false
try {
  require('@larksuiteoapi/node-sdk')
  hasLarkSDK = true
  console.log('  ✓ @larksuiteoapi/node-sdk available')
} catch {
  try {
    require('@larksuite/node-sdk')
    hasLarkSDK = true
    console.log('  ✓ @larksuite/node-sdk available')
  } catch {
    console.log('  ⚠ No Lark SDK found — WebSocket mode unavailable')
    console.log('    Install: bun add @larksuiteoapi/node-sdk')
    console.log('    Will use webhook mode for full test')
  }
}

// ─── Step 4: Start mock upstream + gateway with Feishu ───

console.log('\n── Step 4: Full Gateway Test ──')

// Mock upstream that echoes back
const mockUpstream = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>
      const messages = body.messages as Array<{ role: string; content: string }>
      const lastUser = messages?.filter(m => m.role === 'user').pop()
      const reply = `[飞书测试回复] 收到消息: "${lastUser?.content ?? '(空)'}"`

      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            const chunk = {
              id: 'test', object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model: 'mock',
              choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
            }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
            const done = {
              id: 'test', object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000), model: 'mock',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`))
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
      }

      return Response.json({
        id: 'test', object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log(`  ✓ Mock upstream on :${MOCK_PORT}`)

// Configure environment
process.env.OPENAI_BASE_URL = `http://localhost:${MOCK_PORT}`
process.env.OPENAI_API_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.ANTHROPIC_MODEL = 'mock-model'
process.env.FEISHU_APP_ID = FEISHU_APP_ID
process.env.FEISHU_APP_SECRET = FEISHU_APP_SECRET
process.env.GATEWAY_ALLOW_ALL_USERS = 'true'
// Also enable API Server so we can test via HTTP
process.env.API_SERVER_ENABLED = 'true'
process.env.API_SERVER_PORT = String(API_PORT)

if (!hasLarkSDK) {
  process.env.FEISHU_CONNECTION_MODE = 'webhook'
}

const { GatewayRunner } = await import('./runner')
const { loadGatewayConfig } = await import('./config')

const config = loadGatewayConfig()
config.streaming.enabled = true

const runner = new GatewayRunner(config)
await runner.start()

const feishuAdapter = runner.adapters.get('feishu' as any)
const apiAdapter = runner.adapters.get('api_server' as any)

console.log(`  ✓ Gateway started`)
console.log(`    Adapters: ${Array.from(runner.adapters.keys()).join(', ')}`)
console.log(`    Feishu: ${feishuAdapter ? '✓ connected' : '✗ not connected'}`)
console.log(`    API Server: ${apiAdapter ? '✓ connected' : '✗ not connected'}`)

// ─── Step 5: Test sending a message via Feishu API ───

console.log('\n── Step 5: Feishu Send Test ──')
if (feishuAdapter) {
  // Try to send a test message (will fail if bot has no chats, which is expected)
  console.log('  Attempting to send test message via Feishu API...')
  const result = await feishuAdapter.send(
    'oc_test_placeholder',
    '🧪 Gateway 连接测试 — 如果你看到这条消息，说明飞书 adapter 发送功能正常！',
  )
  if (result.success) {
    console.log(`  ✓ Message sent! ID: ${result.messageId}`)
  } else {
    console.log(`  ⚠ Send returned error (expected if no chat): ${result.error}`)
    console.log('    This is normal — the bot needs an active chat to send to.')
    console.log('    Try messaging the bot in 飞书, and it will reply!')
  }
}

// ─── Step 6: Test via API Server endpoint ───

console.log('\n── Step 6: API Server Passthrough ──')
try {
  const resp = await fetch(`http://localhost:${API_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      messages: [{ role: 'user', content: '飞书测试 hello!' }],
      stream: false,
    }),
  })
  const data = await resp.json() as Record<string, unknown>
  const choices = data.choices as Array<Record<string, unknown>>
  const content = (choices?.[0]?.message as Record<string, unknown>)?.content as string
  if (content?.includes('飞书测试回复')) {
    console.log(`  ✓ API Server → Mock Upstream 链路正常`)
    console.log(`    Response: ${content}`)
  } else {
    console.log(`  ✗ Unexpected response: ${JSON.stringify(data).slice(0, 200)}`)
  }
} catch (err) {
  console.log(`  ✗ API Server test failed: ${err}`)
}

// ─── Summary ───

console.log('\n═══════════════════════════════════════')
console.log('  测试总结')
console.log('═══════════════════════════════════════')
console.log(`  Token 获取:      ✓`)
console.log(`  飞书 Adapter:    ${feishuAdapter ? '✓ 已连接' : '✗ 未连接'}`)
console.log(`  API Server:      ${apiAdapter ? '✓ 已连接' : '✗ 未连接'}`)
console.log(`  连接模式:        ${hasLarkSDK ? 'WebSocket' : 'Webhook'}`)

if (feishuAdapter) {
  console.log('\n  ▶ 飞书 Bot 已启动并监听消息！')
  if (hasLarkSDK) {
    console.log('    在飞书中找到你的 Bot 并发送消息，Bot 会回复。')
  } else {
    console.log('    Webhook 模式运行中。')
    console.log('    安装 SDK 后可使用 WebSocket 模式: bun add @larksuiteoapi/node-sdk')
  }
  console.log('\n  按 Ctrl+C 停止...\n')

  // Keep running to receive messages
  process.on('SIGINT', async () => {
    console.log('\n  停止中...')
    await runner.stop()
    mockUpstream.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await runner.stop()
    mockUpstream.stop()
    process.exit(0)
  })

  // Keep alive
  await new Promise(() => {})
} else {
  console.log('\n  飞书 Adapter 未连接，请检查配置。')
  await runner.stop()
  mockUpstream.stop()
  process.exit(1)
}
