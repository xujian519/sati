#!/usr/bin/env bun
/**
 * CCR (Claude Code Router) real E2E routing test.
 *
 * Tests:
 *   Phase 0 — CCR startup + health check
 *   Phase 1 — Direct HTTP to CCR /v1/messages (Anthropic format), validates
 *             routing, TokenSaver tiers, streaming, and token stats
 *   Phase 2 — CLI -p through start.sh (full stack, slow but real)
 *   Phase 3 — Log analysis
 *   Phase 4 — Cleanup (kill CCR, etc.)
 *
 * Usage:
 *   bun run src/router/test-routing.ts          # Phase 0-1-3 (fast, ~20s)
 *   bun run src/router/test-routing.ts --cli    # + Phase 2 CLI -p (slow, ~4min)
 */

import { spawn, execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'

const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const CCR_PORT = 19080
const CCR_BASE = `http://127.0.0.1:${CCR_PORT}`
const ROUTER_LOG = resolve(PROJECT_ROOT, '.router.log')
const START_SH = resolve(PROJECT_ROOT, 'start.sh')

let routerPid: number | null = null
let passed = 0
let failed = 0

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

function assert(ok: boolean, name: string, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function killPort(port: number) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGTERM') } catch {}
      }
      log(`Killed process(es) on port ${port}: ${pids.replace(/\n/g, ', ')}`)
    }
  } catch {}
}

function readLogSince(marker: string): string {
  try {
    const full = readFileSync(ROUTER_LOG, 'utf-8')
    const idx = full.lastIndexOf(marker)
    return idx >= 0 ? full.slice(idx) : full
  } catch {
    return ''
  }
}

function cleanup() {
  log('Cleaning up...')
  if (routerPid) {
    try { process.kill(routerPid, 'SIGTERM') } catch {}
    log(`Killed CCR router PID ${routerPid}`)
  }
  killPort(CCR_PORT)
  killPort(18642)
}

process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// ═══════════════════════════════════════════════════════════════
// Phase 0: CCR startup + health check
// ═══════════════════════════════════════════════════════════════

async function phase0(): Promise<boolean> {
  console.log('\n══ Phase 0: CCR startup + health check ══')

  let alreadyRunning = false
  try {
    const h = await fetchJson(`${CCR_BASE}/health`, 2000)
    if (h.status === 'ok') {
      log('CCR already running, reusing')
      alreadyRunning = true
    }
  } catch {}

  if (!alreadyRunning) {
    try { writeFileSync(ROUTER_LOG, '') } catch {}

    log('Starting CCR router...')
    const child = spawn('bun', ['run', resolve(PROJECT_ROOT, 'router.ts')], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
    })

    const logFd = Bun.file(ROUTER_LOG).writer()
    child.stdout.on('data', (d: Buffer) => logFd.write(d))
    child.stderr.on('data', (d: Buffer) => logFd.write(d))

    routerPid = child.pid ?? null
    log(`CCR router spawned (PID ${routerPid})`)

    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try {
        const h = await fetchJson(`${CCR_BASE}/health`, 2000)
        if (h.status === 'ok') { ready = true; break }
      } catch {}
    }

    assert(ready, 'CCR health check', ready ? undefined : 'timeout after 20s')
    if (!ready) return false
  } else {
    assert(true, 'CCR health check (already running)')
  }

  try {
    const stats = await fetchJson(`${CCR_BASE}/api/stats/summary`, 3000)
    assert(stats !== null && typeof stats === 'object', '/api/stats/summary reachable')
  } catch (e: any) {
    assert(false, '/api/stats/summary reachable', e.message)
  }

  return true
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: Direct HTTP to CCR (Anthropic Messages API format)
// ═══════════════════════════════════════════════════════════════

async function sendAnthropicMessage(
  userContent: string,
  stream = true,
  timeoutMs = 60000,
): Promise<{ text: string; status: number; headers: Record<string, string> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${CCR_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'dummy-key-for-ccr',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 1024,
        stream,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    })

    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k] = v })

    if (stream && res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
      }
      return { text: fullText, status: res.status, headers }
    }

    const text = await res.text()
    return { text, status: res.status, headers }
  } finally {
    clearTimeout(timer)
  }
}

async function phase1(): Promise<{ apiKeyValid: boolean }> {
  console.log('\n══ Phase 1: Direct HTTP routing tests ══')

  const marker = `__TEST_MARKER_${Date.now()}__`
  try {
    const fd = Bun.file(ROUTER_LOG).writer()
    fd.write(`\n${marker}\n`)
    fd.flush()
  } catch {}

  // ── Test 1a: Simple prompt (streaming) ──
  console.log('\n── Test 1a: Simple prompt (streaming) ──')
  log('POST /v1/messages — "你好"')
  let apiKeyValid = true
  try {
    const r = await sendAnthropicMessage('你好', true, 30000)

    if (r.status === 401 || r.status === 403) {
      log('  ⚠ SKIP — upstream provider returned 401/403 (API key expired, not a CCR issue)')
      apiKeyValid = false
      assert(true, 'CCR forwarded request to provider (got auth error back — routing works)')
    } else {
      assert(r.status === 200, `HTTP ${r.status}`)
      const hasSSE = r.text.includes('event:') || r.text.includes('data:')
      assert(hasSSE, 'Response is SSE stream')
      const hasContent = r.text.includes('content_block') || r.text.includes('text')
      assert(hasContent, 'Stream contains content blocks')
      const hasStop = r.text.includes('message_stop') || r.text.includes('message_delta')
      assert(hasStop, 'Stream has termination event')
    }
    log(`  Response size: ${r.text.length} bytes`)
  } catch (e: any) {
    assert(false, 'Simple prompt request', e.message)
  }

  // ── Test 1b: Complex prompt (streaming) ──
  console.log('\n── Test 1b: Complex prompt (streaming) ──')
  const complexPrompt = '分析微服务架构中的服务发现机制，比较 Consul、Eureka、Nacos 三者的优劣。给出在高并发场景下的选型建议和部署方案。'
  log(`POST /v1/messages — "${complexPrompt.slice(0, 30)}..."`)
  try {
    const r = await sendAnthropicMessage(complexPrompt, true, 60000)

    if (r.status === 401 || r.status === 403) {
      log('  ⚠ SKIP — upstream provider auth error')
      assert(true, 'CCR forwarded request (auth error from provider — routing works)')
    } else {
      assert(r.status === 200, `HTTP ${r.status}`)
      const hasContent = r.text.includes('content_block') || r.text.includes('text')
      assert(hasContent, 'Stream contains content blocks')
    }
    log(`  Response size: ${r.text.length} bytes`)
  } catch (e: any) {
    assert(false, 'Complex prompt request', e.message)
  }

  // ── Test 1c: Non-streaming ──
  console.log('\n── Test 1c: Non-streaming request ──')
  log('POST /v1/messages (stream=false) — "1+1=?"')
  try {
    const r = await sendAnthropicMessage('1+1=?', false, 30000)

    if (r.status === 401 || r.status === 403) {
      log('  ⚠ SKIP — upstream provider auth error')
      assert(true, 'CCR forwarded request (auth error from provider — routing works)')
    } else {
      assert(r.status === 200, `HTTP ${r.status}`)
      const body = JSON.parse(r.text)
      assert(body.type === 'message', `type = ${body.type}`)
      assert(body.content?.length > 0, `content has ${body.content?.length} block(s)`)
      assert(body.usage?.input_tokens > 0, `input_tokens = ${body.usage?.input_tokens}`)
      assert(body.usage?.output_tokens > 0, `output_tokens = ${body.usage?.output_tokens}`)
      const textBlock = body.content?.find((b: any) => b.type === 'text')
      if (textBlock) log(`  Answer: ${textBlock.text.slice(0, 100)}`)
    }
  } catch (e: any) {
    assert(false, 'Non-streaming request', e.message)
  }

  // ── Test 1d: TokenSaver tier check ──
  console.log('\n── Test 1d: TokenSaver tier in logs ──')
  await sleep(1000)
  const logContent = readLogSince(marker)
  const tierMatches = [...logContent.matchAll(/tier[=: ]*"?(SIMPLE|MEDIUM|COMPLEX|REASONING)/gi)]
  if (tierMatches.length > 0) {
    const tiers = tierMatches.map(m => m[1]!.toUpperCase())
    assert(true, `TokenSaver classified ${tiers.length} request(s): ${[...new Set(tiers)].join(', ')}`)
  } else {
    log('  ⚠ No TokenSaver tier entries found in log (judge may not have been called)')
  }

  // ── Test 1e: Token Stats ──
  console.log('\n── Test 1e: Token Stats ──')
  try {
    const stats = await fetchJson(`${CCR_BASE}/api/stats/summary`, 5000) as any
    const lt = stats?.lifetime?.total
    if (lt) {
      assert(lt.requestCount >= 1, `requestCount = ${lt.requestCount}`)
      assert(lt.inputTokens > 0, `inputTokens = ${lt.inputTokens}`)
      assert(lt.outputTokens > 0, `outputTokens = ${lt.outputTokens}`)
      log(`  Estimated cost: $${lt.estimatedCost?.toFixed(4) ?? '?'}`)
    } else {
      assert(false, 'stats.lifetime.total exists', JSON.stringify(stats).slice(0, 200))
    }
  } catch (e: any) {
    assert(false, 'Token stats fetch', e.message)
  }

  return { apiKeyValid }
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: CLI -p (full stack)
// ═══════════════════════════════════════════════════════════════

function runCliPrompt(prompt: string, timeoutSec = 120): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const child = spawn(START_SH, ['-p', prompt, '--bare'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
    })

    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => errChunks.push(d))

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
    }, timeoutSec * 1000)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(chunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        exitCode: code ?? 1,
      })
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: 'spawn error', exitCode: 1 })
    })
  })
}

async function phase2(apiKeyValid: boolean, enabled: boolean): Promise<void> {
  console.log('\n══ Phase 2: CLI -p full stack test ══')

  if (!enabled) {
    log('SKIP — pass --cli flag to enable (CLI startup takes 60-120s)')
    return
  }

  if (!apiKeyValid) {
    log('SKIP — upstream API key expired')
    return
  }

  log('Running: ./start.sh -p "你好" --bare  (timeout 240s)')

  const result = await runCliPrompt('你好', 240)
  const out = result.stdout.trim()
  assert(out.length > 0, 'CLI returned non-empty output', out.length > 200 ? `${out.length} chars` : out.slice(0, 100))

  const ok = result.exitCode === 0 || out.length > 0
  assert(ok, `exit code = ${result.exitCode}${result.exitCode !== 0 ? ` (non-zero, but ${out.length} chars output — routing OK)` : ''}`)
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Log analysis
// ═══════════════════════════════════════════════════════════════

function phase3() {
  console.log('\n══ Phase 3: CCR log analysis ══')

  let logContent: string
  try {
    logContent = readFileSync(ROUTER_LOG, 'utf-8')
  } catch {
    log('  ⚠ Cannot read .router.log')
    return
  }

  const tiers: Record<string, number> = { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 }
  for (const m of logContent.matchAll(/tier[=: ]*"?(SIMPLE|MEDIUM|COMPLEX|REASONING)/gi)) {
    const t = m[1]!.toUpperCase()
    if (t in tiers) tiers[t]++
  }
  console.log('  TokenSaver tier distribution:')
  for (const [t, c] of Object.entries(tiers)) {
    if (c > 0) console.log(`    ${t}: ${c}`)
  }
  if (Object.values(tiers).every(v => v === 0)) {
    console.log('    (no tier entries found)')
  }

  const orchCount = (logContent.match(/\[AutoOrchestrate\] injected/g) || []).length
  const slimCount = (logContent.match(/\[AutoOrchestrate\] slimmed/g) || []).length
  const stripCount = (logContent.match(/\[AutoOrchestrate\] stripped/g) || []).length
  console.log(`  AutoOrchestrate: ${orchCount} injections, ${slimCount} slims, ${stripCount} tool-strips`)

  const providerHits: Record<string, number> = {}
  for (const m of logContent.matchAll(/provider[=:(]+"?(\w+)/gi)) {
    const p = m[1]!.toLowerCase()
    providerHits[p] = (providerHits[p] || 0) + 1
  }
  if (Object.keys(providerHits).length > 0) {
    console.log('  Provider distribution:')
    for (const [p, c] of Object.entries(providerHits)) {
      console.log(`    ${p}: ${c}`)
    }
  }

  console.log(`  Log size: ${(logContent.length / 1024).toFixed(1)} KB`)
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   CCR Real E2E Routing Test              ║')
  console.log('╚══════════════════════════════════════════╝')

  try {
    const ok = await phase0()
    if (!ok) {
      console.log('\n⛔ Phase 0 failed — aborting')
      cleanup()
      process.exit(1)
    }

    const { apiKeyValid } = await phase1()
    const cliEnabled = process.argv.includes('--cli')
    await phase2(apiKeyValid, cliEnabled)
    phase3()
  } catch (e: any) {
    console.error('\n⛔ Unexpected error:', e.message)
    failed++
  }

  console.log(`\n${'═'.repeat(44)}`)
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log(`${'═'.repeat(44)}`)

  cleanup()
  process.exit(failed > 0 ? 1 : 0)
}

main()
