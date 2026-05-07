import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  consumeCronDaemonNotifications,
  enqueueCronDaemonNotification,
  readCronDaemonNotifications,
} from './notificationInbox.js'

describe('Cron daemon notification inbox', () => {
  let configDir: string
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'cron-daemon-notifications-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (priorConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = priorConfigDir
    }
    await rm(configDir, { recursive: true, force: true })
  })

  test('consumes notifications per origin session bucket', async () => {
    await enqueueCronDaemonNotification('session-a', '<task-notification>a1')
    await new Promise(resolve => setTimeout(resolve, 2))
    await enqueueCronDaemonNotification('session-a', '<task-notification>a2')
    await enqueueCronDaemonNotification('session-b', '<task-notification>b1')

    const sessionANotifications = await readCronDaemonNotifications('session-a')
    expect(sessionANotifications).toHaveLength(2)
    expect(sessionANotifications[0]?.sessionId).toBe('session-a')
    expect(sessionANotifications[1]?.sessionId).toBe('session-a')

    const consumed: string[] = []
    const delivered = await consumeCronDaemonNotifications(['session-a'], n => {
      consumed.push(n.message)
    })

    expect(delivered).toBe(2)
    expect(consumed).toEqual([
      '<task-notification>a1',
      '<task-notification>a2',
    ])
    expect(await readCronDaemonNotifications('session-a')).toHaveLength(0)
    expect(await readCronDaemonNotifications('session-b')).toHaveLength(1)
  })
})
