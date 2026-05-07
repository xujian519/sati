#!/usr/bin/env bun
/**
 * End-to-end gateway test.
 *
 * Spins up:
 *   1. A mock OpenAI-compatible upstream (echo server)
 *   2. The gateway with API Server adapter enabled
 *
 * Then sends requests through the gateway and verifies responses.
 *
 * Usage:
 *   bun run gateway/test-e2e.ts
 */

const MOCK_PORT = 19999
const GATEWAY_PORT = 18642

// ─── 1. Mock upstream: echoes back the user message ───

const mockUpstream = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>
      const messages = body.messages as Array<{ role: string; content: string }>
      const lastUser = messages?.filter(m => m.role === 'user').pop()
      const reply = `Echo: ${lastUser?.content ?? '(empty)'}`
      const streaming = body.stream === true

      if (streaming) {
        // SSE streaming response
        const chunks = [
          {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]

        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        })

        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      // Non-streaming response
      return Response.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
})

console.log(`\n✓ Mock upstream started on http://localhost:${MOCK_PORT}`)

// ─── 2. Configure and start gateway ───

process.env.OPENAI_BASE_URL = `http://localhost:${MOCK_PORT}`
process.env.OPENAI_API_KEY = 'test-key'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.ANTHROPIC_MODEL = 'mock-model'
process.env.API_SERVER_ENABLED = 'true'
process.env.API_SERVER_PORT = String(GATEWAY_PORT)
process.env.GATEWAY_ALLOW_ALL_USERS = 'true'

const { GatewayRunner } = await import('./runner')
const { loadGatewayConfig } = await import('./config')

const config = loadGatewayConfig()
// Enable streaming for tests
config.streaming.enabled = true

const runner = new GatewayRunner(config)
await runner.start()

console.log(`✓ Gateway started with API Server on http://localhost:${GATEWAY_PORT}`)

// Wait a moment for server to be ready
await new Promise(r => setTimeout(r, 500))

// ─── 3. Run tests ───

let passed = 0
let failed = 0

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

const BASE = `http://localhost:${GATEWAY_PORT}`

// Test 1: Health check
console.log('\n── Test 1: Health check ──')
try {
  const resp = await fetch(`${BASE}/health`)
  const data = await resp.json() as Record<string, unknown>
  assert(resp.ok, 'GET /health returns 200')
  assert(data.status === 'ok', 'Health status is ok')
} catch (err) {
  assert(false, 'GET /health', String(err))
}

// Test 2: Models endpoint
console.log('\n── Test 2: Models endpoint ──')
try {
  const resp = await fetch(`${BASE}/v1/models`)
  const data = await resp.json() as Record<string, unknown>
  assert(resp.ok, 'GET /v1/models returns 200')
  assert(data.object === 'list', 'Returns model list')
  const models = data.data as Array<Record<string, unknown>>
  assert(models?.length > 0, `Has ${models?.length} model(s)`)
} catch (err) {
  assert(false, 'GET /v1/models', String(err))
}

// Test 3: Non-streaming chat completion
console.log('\n── Test 3: Non-streaming chat completion ──')
try {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello gateway!' }],
      stream: false,
    }),
  })
  assert(resp.ok, `POST returns ${resp.status}`)
  const data = await resp.json() as Record<string, unknown>
  assert(data.object === 'chat.completion', 'Returns chat.completion object')
  const choices = data.choices as Array<Record<string, unknown>>
  const content = (choices?.[0]?.message as Record<string, unknown>)?.content as string
  assert(content?.includes('Echo: Hello gateway!'), `Response echoes back: "${content?.slice(0, 60)}"`)
} catch (err) {
  assert(false, 'Non-streaming request', String(err))
}

// Test 4: Streaming chat completion
console.log('\n── Test 4: Streaming chat completion ──')
try {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello streaming!' }],
      stream: true,
    }),
  })
  assert(resp.ok, `POST returns ${resp.status}`)
  assert(
    resp.headers.get('Content-Type')?.includes('text/event-stream') ?? false,
    'Content-Type is text/event-stream',
  )

  const text = await resp.text()
  const lines = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
  assert(lines.length > 0, `Got ${lines.length} SSE data line(s)`)

  let foundContent = false
  for (const line of lines) {
    try {
      const chunk = JSON.parse(line.slice(6))
      if (chunk.choices?.[0]?.delta?.content) {
        foundContent = true
      }
    } catch {}
  }
  assert(foundContent, 'Stream contains content delta')

  const hasDone = text.includes('data: [DONE]')
  assert(hasDone, 'Stream ends with [DONE]')
} catch (err) {
  assert(false, 'Streaming request', String(err))
}

// Test 5: Auth rejection (when key is set)
console.log('\n── Test 5: Error handling ──')
try {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x' }),
  })
  assert(!resp.ok || resp.status >= 400, 'Missing messages returns error')
} catch (err) {
  assert(false, 'Error handling', String(err))
}

// Test 6: Session persistence
console.log('\n── Test 6: Session persistence (SQLite) ──')
try {
  const { SessionStore, buildSessionKey } = await import('./session')
  const { createDefaultGatewayConfig, Platform } = await import('./types')

  const testConfig = createDefaultGatewayConfig()
  testConfig.sessionsDir = '/tmp/gateway-test-sessions-' + Date.now()
  const store = new SessionStore(testConfig.sessionsDir, testConfig)

  const source = {
    platform: Platform.TELEGRAM,
    chatId: 'test-chat-123',
    chatType: 'dm' as const,
    userId: 'user-456',
  }

  const s1 = store.getOrCreateSession(source)
  assert(!!s1.sessionId, `Session created: ${s1.sessionId}`)

  // Message bodies are owned by the Claude Code SDK's .jsonl transcripts;
  // the gateway no longer mirrors them, so addMessage/getMessages are no-ops.

  const s2 = store.getOrCreateSession(source)
  assert(s1.sessionId === s2.sessionId, 'Same session returned on re-access')

  const key = buildSessionKey(source)
  assert(key === 'agent:main:telegram:dm:test-chat-123', `Key: ${key}`)

  store.close()
} catch (err) {
  assert(false, 'Session persistence', String(err))
}

// Test 7: Stream consumer
console.log('\n── Test 7: Stream consumer ──')
try {
  const { GatewayStreamConsumer } = await import('./stream-consumer')

  const sentMessages: string[] = []
  const editedMessages: Array<[string, string]> = []

  const mockAdapter = {
    MAX_MESSAGE_LENGTH: 4096,
    send: async (_chatId: string, content: string) => {
      sentMessages.push(content)
      return { success: true, messageId: 'msg-1' }
    },
    editMessage: async (_chatId: string, _msgId: string, content: string) => {
      editedMessages.push([_msgId, content])
      return { success: true, messageId: _msgId }
    },
    truncateMessage: (content: string, limit: number) => {
      if (content.length <= limit) return [content]
      return [content.slice(0, limit), content.slice(limit)]
    },
  } as any

  const consumer = new GatewayStreamConsumer(mockAdapter, 'test-chat', {
    editInterval: 0.05,
    bufferThreshold: 10,
    cursor: ' ▉',
  })

  const runPromise = consumer.run()

  consumer.onDelta('Hello')
  await new Promise(r => setTimeout(r, 100))
  consumer.onDelta(' world!')
  await new Promise(r => setTimeout(r, 100))
  consumer.finish()
  await runPromise

  assert(sentMessages.length > 0, `Sent ${sentMessages.length} message(s)`)
  assert(consumer.alreadySent, 'Consumer marked as sent')
  assert(consumer.finalResponseSent, 'Final response marked as sent')
} catch (err) {
  assert(false, 'Stream consumer', String(err))
}

// ─── Summary ───

console.log(`\n${'═'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`${'═'.repeat(40)}`)

// ─── Cleanup ───

await runner.stop()
mockUpstream.stop()

process.exit(failed > 0 ? 1 : 0)
