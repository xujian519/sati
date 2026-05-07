import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireDiscoveryLock, releaseDiscoveryLock } from './lock.js'

describe('always-on discovery lock', () => {
  test('prevents duplicate acquire until release', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-lock-'))

    expect(await acquireDiscoveryLock(projectRoot)).toBe(true)
    expect(await acquireDiscoveryLock(projectRoot)).toBe(false)

    await releaseDiscoveryLock(projectRoot)
    expect(await acquireDiscoveryLock(projectRoot)).toBe(true)
  })
})
