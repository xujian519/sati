import { describe, expect, test } from 'bun:test'
import { startCronDaemonClientLease } from './clientLeaseController.js'

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('startCronDaemonClientLease', () => {
  test('registers and unregisters a TUI client', async () => {
    const requests: unknown[] = []
    const lease = startCronDaemonClientLease({
      clientId: '123',
      clientKind: 'tui',
      processId: 123,
      projectRoots: ['/workspace'],
      intervalMs: 60_000,
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

    await tick()
    await lease.stop()

    expect(requests).toEqual([
      {
        type: 'register_client',
        clientId: '123',
        clientKind: 'tui',
        processId: 123,
        projectRoots: ['/workspace'],
      },
      {
        type: 'unregister_client',
        clientId: '123',
      },
    ])
  })

  test('stop is idempotent and waits for unregister', async () => {
    const requests: unknown[] = []
    let unregisterResolved = false
    const lease = startCronDaemonClientLease({
      clientId: 'tui-idempotent',
      clientKind: 'tui',
      intervalMs: 60_000,
      requestCronDaemonFn: async request => {
        requests.push(request)
        if (request.type === 'unregister_client') {
          await tick()
          unregisterResolved = true
        }
        return {
          ok: true,
          data: {
            type: request.type,
            activeClients: request.type === 'unregister_client' ? 0 : 1,
          },
        } as any
      },
    })

    await tick()
    await Promise.all([lease.stop(), lease.stop()])

    expect(unregisterResolved).toBe(true)
    expect(
      requests.filter(
        request =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'unregister_client',
      ),
    ).toHaveLength(1)
  })
})
