import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFreshHeartbeats, hasBusyHeartbeat, hasRecentUserMessage } from './heartbeats.js'
import { getAlwaysOnHeartbeatsDir, getAlwaysOnHeartbeatPath } from '../../utils/alwaysOnPaths.js'

describe('always-on discovery heartbeats', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'always-on-heartbeats-'))
    await mkdir(getAlwaysOnHeartbeatsDir(projectRoot), { recursive: true })
  })

  test('reads fresh beats', async () => {
    await writeFile(
      getAlwaysOnHeartbeatPath(projectRoot, 'webui-a.beat'),
      JSON.stringify({
        schemaVersion: 1,
        writerKind: 'webui',
        writerId: 'a',
        writtenAt: '2026-04-29T00:00:00.000Z',
        agentBusy: false,
        processingSessionIds: [],
        lastUserMsgAt: null,
      }),
    )

    const beats = await readFreshHeartbeats(
      projectRoot,
      90,
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(beats).toHaveLength(1)
    expect(beats[0]?.writerId).toBe('a')
  })

  test('deletes stale and malformed beats', async () => {
    const stalePath = getAlwaysOnHeartbeatPath(projectRoot, 'stale.beat')
    const malformedPath = getAlwaysOnHeartbeatPath(projectRoot, 'bad.beat')
    await writeFile(
      stalePath,
      JSON.stringify({
        schemaVersion: 1,
        writerKind: 'webui',
        writerId: 'stale',
        writtenAt: '2026-04-29T00:00:00.000Z',
        agentBusy: false,
        processingSessionIds: [],
      }),
    )
    await writeFile(malformedPath, '{')

    const beats = await readFreshHeartbeats(
      projectRoot,
      90,
      new Date('2026-04-29T00:02:00.000Z'),
    )

    expect(beats).toHaveLength(0)
    expect(existsSync(stalePath)).toBe(false)
    expect(existsSync(malformedPath)).toBe(false)
  })

  test('detects busy and recent user message', () => {
    const beats = [
      {
        schemaVersion: 1 as const,
        writerKind: 'tui' as const,
        writerId: '123',
        writtenAt: '2026-04-29T00:00:00.000Z',
        agentBusy: true,
        processingSessionIds: [],
        lastUserMsgAt: '2026-04-29T00:04:00.000Z',
      },
    ]

    expect(hasBusyHeartbeat(beats)).toBe(true)
    expect(
      hasRecentUserMessage(beats, 5, new Date('2026-04-29T00:08:00.000Z')),
    ).toBe(true)
  })
})
