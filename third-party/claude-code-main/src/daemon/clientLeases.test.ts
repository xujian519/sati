import { describe, expect, test } from 'bun:test'
import { ClientLeaseRegistry } from './clientLeases.js'

describe('ClientLeaseRegistry', () => {
  test('sweeps expired client leases', () => {
    let now = 1_000
    const leases = new ClientLeaseRegistry(100, 1_000, () => now)

    leases.upsert({
      clientId: 'webui-1',
      clientKind: 'webui',
      projectRoots: [],
    })
    expect(leases.count()).toBe(1)

    now = 1_101
    expect(leases.sweepExpired()).toBe(1)
    expect(leases.count()).toBe(0)
  })

  test('uses shorter default TTL for abandoned clients', () => {
    let now = 1_000
    const leases = new ClientLeaseRegistry(undefined, undefined, () => now)
    leases.upsert({
      clientId: 'tui-1',
      clientKind: 'tui',
      projectRoots: [],
    })

    now = 30_001
    expect(leases.count()).toBe(1)

    now = 31_001
    expect(leases.count()).toBe(0)
  })
})
