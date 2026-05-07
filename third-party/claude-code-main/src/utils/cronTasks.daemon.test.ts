import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addCronTask,
  markCronTasksFired,
  readCronTasks,
  updateCronTask,
} from './cronTasks.js'
import type { CronTask } from './cronTasks.js'

test('addCronTask routes session-only tasks to injected session store', async () => {
  let captured: CronTask | null = null

  const id = await addCronTask('*/5 * * * *', 'daemon task', true, false, undefined, {
    originSessionId: 'session-123',
    addSessionTask: task => {
      captured = task
    },
  })

  expect(id).toHaveLength(8)
  expect(captured).toMatchObject({
    id,
    cron: '*/5 * * * *',
    prompt: 'daemon task',
    recurring: true,
    originSessionId: 'session-123',
    durable: false,
  })
})

test('addCronTask keeps durable tasks on disk even with an injected session store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-tasks-daemon-'))
  let captured: CronTask | null = null

  try {
    const id = await addCronTask(
      '0 9 * * *',
      'durable daemon task',
      true,
      true,
      undefined,
      {
        dir,
        originSessionId: 'session-456',
        addSessionTask: task => {
          captured = task
        },
      },
    )

    expect(captured).toBeNull()
    expect(await readCronTasks(dir)).toContainEqual({
      id,
      cron: '0 9 * * *',
      prompt: 'durable daemon task',
      createdAt: expect.any(Number),
      recurring: true,
      originSessionId: 'session-456',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('markCronTasksFired preserves recurring transcript metadata already on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-tasks-daemon-'))

  try {
    const id = await addCronTask(
      '0 9 * * *',
      'durable daemon task',
      true,
      true,
      undefined,
      {
        dir,
        originSessionId: 'session-789',
      },
    )
    const firedAt = Date.now()

    await updateCronTask(
      id,
      task => ({
        ...task,
        transcriptKey: 'cron-thread-123',
      }),
      dir,
    )
    await markCronTasksFired([id], firedAt, dir)

    expect(await readCronTasks(dir)).toContainEqual({
      id,
      cron: '0 9 * * *',
      prompt: 'durable daemon task',
      createdAt: expect.any(Number),
      recurring: true,
      originSessionId: 'session-789',
      transcriptKey: 'cron-thread-123',
      lastFiredAt: firedAt,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
