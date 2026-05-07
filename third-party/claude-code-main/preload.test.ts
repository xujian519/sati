import { describe, expect, test } from 'bun:test'

const priorCcrDisabled = process.env.CCR_DISABLED
process.env.CCR_DISABLED = '1'
const { shouldInstallCcrInterceptor } = await import('./preload')
if (priorCcrDisabled === undefined) {
  delete process.env.CCR_DISABLED
} else {
  process.env.CCR_DISABLED = priorCcrDisabled
}

describe('shouldInstallCcrInterceptor', () => {
  test('keeps existing non-daemon behavior', () => {
    expect(shouldInstallCcrInterceptor({}, ['cli.tsx'])).toBe(true)
    expect(
      shouldInstallCcrInterceptor(
        { ANTHROPIC_BASE_URL: 'http://ccr.local' },
        ['cli.tsx'],
      ),
    ).toBe(true)
  })

  test('does not install when disabled or an external base URL is configured', () => {
    expect(
      shouldInstallCcrInterceptor({ CCR_DISABLED: '1' }, ['cli.tsx']),
    ).toBe(false)
    expect(
      shouldInstallCcrInterceptor(
        { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080' },
        ['cli.tsx'],
      ),
    ).toBe(false)
  })

  test('allows daemon contexts only for sentinel or explicit opt-in', () => {
    const daemonArgs = ['--preload', 'preload.ts', '-e', 'runDaemonWorker()']

    expect(shouldInstallCcrInterceptor({}, daemonArgs)).toBe(false)
    expect(
      shouldInstallCcrInterceptor(
        { ANTHROPIC_BASE_URL: 'http://ccr.local' },
        daemonArgs,
      ),
    ).toBe(true)
    expect(
      shouldInstallCcrInterceptor(
        { CCR_DAEMON_FETCH_INTERCEPTOR: '1' },
        daemonArgs,
      ),
    ).toBe(true)
  })
})
