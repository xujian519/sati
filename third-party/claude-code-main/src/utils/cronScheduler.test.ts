import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCronScheduler,
  persistFiredRecurringTasks,
} from './cronScheduler.js'
import { readCronTasks, updateCronTask, writeCronTasks } from './cronTasks.js'
import { sleep } from './sleep.js'

describe('persistFiredRecurringTasks', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cron-scheduler-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('waits for recurring transcript persistence before stamping lastFiredAt', async () => {
    const taskId = 'deadbeef'
    const createdAt = Date.now() - 5 * 60_000
    const firedAt = Date.now()

    await writeCronTasks(
      [
        {
          id: taskId,
          cron: '* * * * *',
          prompt: 'ping',
          createdAt,
          recurring: true,
          originSessionId: 'session-1',
        },
      ],
      dir,
    )

    const pendingTranscriptWrite = (async () => {
      await sleep(10)
      await updateCronTask(
        taskId,
        task => ({
          ...task,
          transcriptKey: 'cron-thread-123',
        }),
        dir,
      )
    })()

    await persistFiredRecurringTasks(
      [taskId],
      firedAt,
      [pendingTranscriptWrite],
      dir,
      async (ids, firedAtMs, targetDir) => {
        const tasks = await readCronTasks(targetDir)
        await sleep(25)
        for (const task of tasks) {
          if (ids.includes(task.id)) {
            task.lastFiredAt = firedAtMs
          }
        }
        await writeCronTasks(tasks, targetDir)
      },
    )

    await expect(readCronTasks(dir)).resolves.toContainEqual({
      id: taskId,
      cron: '* * * * *',
      prompt: 'ping',
      createdAt,
      recurring: true,
      originSessionId: 'session-1',
      transcriptKey: 'cron-thread-123',
      lastFiredAt: firedAt,
    })
  })
})

describe('createCronScheduler', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cron-scheduler-manual-only-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('does not auto-fire manual-only tasks', async () => {
    await writeCronTasks(
      [
        {
          id: 'manualonly',
          cron: '* * * * *',
          prompt: 'proposal',
          createdAt: Date.now() - 90_000,
          recurring: true,
          manualOnly: true,
          originSessionId: 'session-1',
        },
      ],
      dir,
    )

    let fired = false
    const scheduler = createCronScheduler({
      dir,
      onFire: () => {
        fired = true
      },
    })

    try {
      scheduler.start()
      await sleep(1800)
    } finally {
      scheduler.stop()
    }

    expect(fired).toBe(false)
    await expect(readCronTasks(dir)).resolves.toContainEqual({
      id: 'manualonly',
      cron: '* * * * *',
      prompt: 'proposal',
      createdAt: expect.any(Number),
      recurring: true,
      manualOnly: true,
      originSessionId: 'session-1',
    })
  })

  test('passes fire source context to onFireTask', async () => {
    const createdAt = Date.now() - 2 * 60_000
    await writeCronTasks(
      [
        {
          id: 'filetask',
          cron: '* * * * *',
          prompt: 'file-backed',
          createdAt,
          recurring: true,
          originSessionId: 'session-1',
        },
      ],
      dir,
    )

    const contexts: Array<{ id: string; isSession: boolean }> = []
    const scheduler = createCronScheduler({
      dir,
      runtimeTaskSource: {
        listTasks: () => [
          {
            id: 'runtime1',
            cron: '* * * * *',
            prompt: 'runtime',
            createdAt,
            recurring: true,
            originSessionId: 'session-1',
          },
        ],
        removeTasks: () => {},
        markTasksFired: () => {},
      },
      getJitterConfig: () => ({
        recurringFrac: 0,
        recurringCapMs: 0,
        oneShotMaxMs: 0,
        oneShotFloorMs: 0,
        oneShotMinuteMod: 1,
        recurringMaxAgeMs: 0,
      }),
      onFire: () => {},
      onFireTask: (task, context) => {
        contexts.push({ id: task.id, isSession: context.isSession })
      },
    })

    try {
      scheduler.start()
      await sleep(1800)
    } finally {
      scheduler.stop()
    }

    expect(contexts).toContainEqual({ id: 'filetask', isSession: false })
    expect(contexts).toContainEqual({ id: 'runtime1', isSession: true })
  })
})
