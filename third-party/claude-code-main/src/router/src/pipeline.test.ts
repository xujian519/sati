import { afterEach, describe, expect, test } from 'bun:test'
import { installFetchInterceptor } from './pipeline'

const originalFetch = globalThis.fetch

function resetFetch(): void {
  globalThis.fetch = originalFetch
  delete (globalThis as any).__originalFetch
  delete (globalThis as any).__ccrFetchInterceptor
}

describe('installFetchInterceptor', () => {
  afterEach(() => {
    resetFetch()
  })

  test('updates services without wrapping fetch repeatedly', async () => {
    const firstServices = {} as any
    const secondServices = {} as any

    installFetchInterceptor('http://ccr.local', firstServices)
    const firstFetch = globalThis.fetch

    installFetchInterceptor('http://ccr.local', secondServices)

    expect(globalThis.fetch).toBe(firstFetch)
    expect((globalThis as any).__ccrFetchInterceptor.services).toBe(
      secondServices,
    )

    const response = await fetch('http://ccr.local/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  test('passes non-sentinel requests to the original fetch', async () => {
    let passthroughUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      passthroughUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      return new Response('passthrough')
    }) as typeof globalThis.fetch

    installFetchInterceptor('http://ccr.local', {} as any)

    const response = await fetch('http://example.com/test')
    expect(await response.text()).toBe('passthrough')
    expect(passthroughUrl).toBe('http://example.com/test')
  })
})
