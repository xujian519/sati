import { afterEach, describe, expect, test } from 'bun:test'
import {
  ensureTuiCronDaemonClientLease,
  resetTuiCronDaemonClientLeaseForTest,
  stopTuiCronDaemonClientLease,
} from './tuiClientLease.js'

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('TUI cron daemon client lease', () => {
  afterEach(async () => {
    await stopTuiCronDaemonClientLease()
    resetTuiCronDaemonClientLeaseForTest()
  })

  test('registers cleanup once and unregisters through graceful cleanup', async () => {
    const requests: unknown[] = []
    const cleanupFns: Array<() => Promise<void>> = []

    ensureTuiCronDaemonClientLease('/workspace/a', {
      force: true,
      registerCleanupFn: cleanup => {
        cleanupFns.push(cleanup)
        return () => {}
      },
      requestCronDaemonFn: async request => {
        requests.push(request)
        return {
          ok: true,
          data: {
            type: request.type,
            activeClients: request.type === 'unregister_client' ? 0 : 1,
          },
        } as any
      },
    })
    ensureTuiCronDaemonClientLease('/workspace/b', { force: true })

    await tick()
    expect(cleanupFns).toHaveLength(1)
    await cleanupFns[0]!()

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'register_client',
          clientKind: 'tui',
          projectRoots: ['/workspace/a'],
        }),
        expect.objectContaining({
          type: 'register_client',
          clientKind: 'tui',
          projectRoots: ['/workspace/a', '/workspace/b'],
        }),
        expect.objectContaining({
          type: 'unregister_client',
        }),
      ]),
    )
    expect(requests.at(-1)).toEqual(
      expect.objectContaining({
        type: 'unregister_client',
      }),
    )
  })
})
