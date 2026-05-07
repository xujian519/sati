import { describe, expect, test } from 'bun:test'
import type { CronTask } from '../utils/cronTasks.js'
import { ensureRecurringTranscript } from './CronBackgroundTask.js'

function createRecurringTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'cron-1',
    cron: '*/5 * * * *',
    prompt: 'ping',
    createdAt: 1,
    recurring: true,
    originSessionId: 'session-a',
    ...overrides,
  }
}

describe('ensureRecurringTranscript', () => {
  test('creates one stable transcript key for a recurring task', async () => {
    let storedTask = createRecurringTask()
    let updateCount = 0

    const first = await ensureRecurringTranscript(storedTask, undefined, async (_id, updater) => {
      updateCount += 1
      storedTask = updater(storedTask)
      return storedTask
    })

    expect(first.transcriptKey.startsWith('cron-thread-')).toBe(true)
    expect(first.transcriptSessionId).toBe('session-a')
    expect(updateCount).toBe(1)

    const second = await ensureRecurringTranscript(storedTask, undefined, async (_id, updater) => {
      updateCount += 1
      storedTask = updater(storedTask)
      return storedTask
    })

    expect(second.transcriptKey).toBe(first.transcriptKey)
    expect(second.transcriptSessionId).toBe('session-a')
    expect(updateCount).toBe(1)
  })

  test('backfills an origin session for older recurring tasks with a transcript key', async () => {
    let storedTask = createRecurringTask({
      transcriptKey: 'cron-thread-existing',
      originSessionId: undefined,
    })

    const result = await ensureRecurringTranscript(storedTask, undefined, async (_id, updater) => {
      storedTask = updater(storedTask)
      return storedTask
    })

    expect(result.transcriptKey).toBe('cron-thread-existing')
    expect(result.task.originSessionId).toBeTruthy()
    expect(result.transcriptSessionId).toBe(result.task.originSessionId!)
  })
})
