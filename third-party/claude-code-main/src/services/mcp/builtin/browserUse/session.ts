import type { Browser, BrowserContext, Page } from 'playwright-core'
import { ensureGlobalChrome, restartGlobalChrome, isCDPHealthy } from './globalChrome.js'

const CDP_CONNECT_TIMEOUT = 15_000
const MAX_CDP_RETRIES = 2
const CDP_RETRY_DELAY_MS = 250

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
}

function normalizeCdpUrl(raw: string): string {
  return raw.replace(/\/$/, '')
}

type CachedConnection = {
  browser: Browser
  context: BrowserContext
  onDisconnected?: () => void
}

const cachedByCdpUrl = new Map<string, CachedConnection>()
const connectingByCdpUrl = new Map<string, Promise<BrowserSession>>()

function isConnectionAlive(cached: CachedConnection): boolean {
  if (!cached.browser.isConnected()) return false
  try {
    cached.context.pages()
    return true
  } catch {
    return false
  }
}

async function connectWithRetry(cdpUrl: string): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core')
  let lastErr: unknown

  for (let attempt = 0; attempt <= MAX_CDP_RETRIES; attempt++) {
    if (attempt > 0 || !(await isCDPHealthy())) {
      const freshUrl = await restartGlobalChrome()
      if (!freshUrl) {
        throw new Error('[browser-use] Chrome restart failed. Check Chrome installation.')
      }
    }

    try {
      const timeout = CDP_CONNECT_TIMEOUT + attempt * 5000
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout })
      const contexts = browser.contexts()
      const context = contexts[0] ?? await browser.newContext()

      const normalized = normalizeCdpUrl(cdpUrl)
      const onDisconnected = () => {
        const current = cachedByCdpUrl.get(normalized)
        if (current?.browser === browser) {
          cachedByCdpUrl.delete(normalized)
        }
      }
      const cached: CachedConnection = { browser, context, onDisconnected }
      cachedByCdpUrl.set(normalized, cached)
      browser.on('disconnected', onDisconnected)

      return { browser, context }
    } catch (err) {
      lastErr = err
      const delay = CDP_RETRY_DELAY_MS + attempt * CDP_RETRY_DELAY_MS
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`[browser-use] Chrome CDP unavailable after ${MAX_CDP_RETRIES + 1} attempts: ${msg}`)
}

/**
 * Get or create a Playwright CDP session.
 *
 * Design inspired by OpenClaw pw-session.ts:
 * - cachedByCdpUrl: reuse existing connections
 * - connectingByCdpUrl: deduplicate in-flight connects
 * - disconnected handler only clears cache, never kills Chrome
 * - No launchPersistentContext fallback (CDP is the only path)
 */
export async function getOrCreateSession(): Promise<BrowserSession> {
  const rawCdpUrl = process.env.CDP_URL ?? await ensureGlobalChrome()
  if (!rawCdpUrl) {
    throw new Error('[browser-use] No Chrome available. Set CDP_URL or install Chrome.')
  }
  const cdpUrl = normalizeCdpUrl(rawCdpUrl)

  const cached = cachedByCdpUrl.get(cdpUrl)
  if (cached && isConnectionAlive(cached)) {
    return { browser: cached.browser, context: cached.context }
  }

  if (cached) {
    cachedByCdpUrl.delete(cdpUrl)
  }

  const inflight = connectingByCdpUrl.get(cdpUrl)
  if (inflight) return inflight

  const pending = connectWithRetry(cdpUrl).finally(() => {
    connectingByCdpUrl.delete(cdpUrl)
  })
  connectingByCdpUrl.set(cdpUrl, pending)
  return pending
}

export async function getActivePage(): Promise<Page> {
  const { context } = await getOrCreateSession()
  const pages = context.pages()
  return pages[pages.length - 1] ?? await context.newPage()
}

export async function getPageByTargetId(targetId: string): Promise<Page | null> {
  const { context } = await getOrCreateSession()
  for (const page of context.pages()) {
    const cdpSession = await context.newCDPSession(page)
    try {
      const info = await cdpSession.send('Target.getTargetInfo')
      if (info.targetInfo.targetId === targetId) {
        return page
      }
    } catch {
      // skip
    } finally {
      await cdpSession.detach().catch(() => {})
    }
  }
  return null
}

/**
 * Close the Playwright CDP connection (not the Chrome process).
 * Mirrors OpenClaw's closePlaywrightBrowserConnection.
 */
export async function closeSession(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null

  if (normalized) {
    const cur = cachedByCdpUrl.get(normalized)
    cachedByCdpUrl.delete(normalized)
    connectingByCdpUrl.delete(normalized)
    if (cur) {
      if (cur.onDisconnected && typeof cur.browser.off === 'function') {
        cur.browser.off('disconnected', cur.onDisconnected)
      }
      await cur.browser.close().catch(() => {})
    }
    return
  }

  const connections = Array.from(cachedByCdpUrl.values())
  cachedByCdpUrl.clear()
  connectingByCdpUrl.clear()
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === 'function') {
      cur.browser.off('disconnected', cur.onDisconnected)
    }
    await cur.browser.close().catch(() => {})
  }
}
