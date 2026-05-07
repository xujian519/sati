import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DaemonSessionTaskStore } from './sessionTaskStore.js'
import type { DaemonCronTask } from './types.js'

function createTask(
  overrides: Partial<DaemonCronTask> = {},
): DaemonCronTask {
  return {
    id: 'task-1',
    cron: '*/5 * * * *',
    prompt: 'ping',
    createdAt: 1,
    originSessionId: 'session-a',
    durable: false,
    ...overrides,
  }
}

describe('DaemonSessionTaskStore', () => {
  test('scopes visibility by origin session id', () => {
    const store = new DaemonSessionTaskStore()
    store.addTask('/tmp/project', createTask())
    store.addTask(
      '/tmp/project',
      createTask({ id: 'task-2', originSessionId: 'session-b' }),
    )

    expect(store.listProjectTasks('/tmp/project')).toHaveLength(2)
    expect(store.listVisibleTasks('/tmp/project', 'session-a')).toHaveLength(1)
    expect(store.listVisibleTasks('/tmp/project', 'session-a')[0]?.id).toBe(
      'task-1',
    )
  })

  test('updates and deletes session-only tasks in place', () => {
    const store = new DaemonSessionTaskStore()
    store.addTask('/tmp/project', createTask())

    const updated = store.updateTask('/tmp/project', 'task-1', task => ({
      ...task,
      transcriptKey: 'cron-thread-1',
      lastRunTaskId: 'cron-run-1',
    }))

    expect(updated?.transcriptKey).toBe('cron-thread-1')
    expect(updated?.lastRunTaskId).toBe('cron-run-1')
    expect(store.deleteTask('/tmp/project', 'task-1', 'session-a')).toBe(true)
    expect(store.listProjectTasks('/tmp/project')).toHaveLength(0)
  })

  test('persists and hydrates session-only tasks from a dedicated project file', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'daemon-session-store-'))
    const store = new DaemonSessionTaskStore()
    store.addTask(projectRoot, createTask())
    store.addTask(
      projectRoot,
      createTask({
        id: 'task-2',
        originSessionId: 'session-b',
        recurring: true,
        lastFiredAt: 123,
        transcriptKey: 'cron-thread-2',
      }),
    )

    await store.persistProject(projectRoot)

    const raw = await readFile(
      join(projectRoot, '.claude', 'session_scheduled_tasks.json'),
      'utf-8',
    )
    expect(raw).toContain('"task-1"')
    expect(raw).toContain('"lastFiredAt": 123')
    expect(raw).not.toContain('"durable"')

    const restored = new DaemonSessionTaskStore()
    await restored.hydrateProject(projectRoot, 0)
    expect(restored.listProjectTasks(projectRoot)).toHaveLength(2)
    expect(restored.getTask(projectRoot, 'task-2')?.transcriptKey).toBe(
      'cron-thread-2',
    )

    await rm(projectRoot, { recursive: true, force: true })
  })

  test('drops expired one-shot tasks during hydration and rewrites the file', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'daemon-session-store-'))
    const store = new DaemonSessionTaskStore()
    store.addTask(
      projectRoot,
      createTask({
        id: 'expired-shot',
        recurring: false,
        cron: '0 9 1 1 *',
        createdAt: 0,
      }),
    )
    store.addTask(
      projectRoot,
      createTask({
        id: 'recurring-1',
        recurring: true,
        cron: '*/5 * * * *',
        createdAt: 0,
      }),
    )
    await store.persistProject(projectRoot)

    const restored = new DaemonSessionTaskStore()
    await restored.hydrateProject(projectRoot, Date.UTC(2026, 3, 20, 4, 0, 0))
    expect(restored.getTask(projectRoot, 'expired-shot')).toBeNull()
    expect(restored.getTask(projectRoot, 'recurring-1')).not.toBeNull()

    const rewritten = await readFile(
      join(projectRoot, '.claude', 'session_scheduled_tasks.json'),
      'utf-8',
    )
    expect(rewritten).not.toContain('expired-shot')
    expect(rewritten).toContain('recurring-1')

    await rm(projectRoot, { recursive: true, force: true })
  })

  test('keeps manual-only one-shot tasks during hydration even after the cron window passes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'daemon-session-store-'))
    const store = new DaemonSessionTaskStore()
    store.addTask(
      projectRoot,
      createTask({
        id: 'manual-shot',
        recurring: false,
        manualOnly: true,
        cron: '0 9 1 1 *',
        createdAt: 0,
      }),
    )
    await store.persistProject(projectRoot)

    const restored = new DaemonSessionTaskStore()
    await restored.hydrateProject(projectRoot, Date.UTC(2026, 3, 20, 4, 0, 0))

    expect(restored.getTask(projectRoot, 'manual-shot')).toMatchObject({
      id: 'manual-shot',
      manualOnly: true,
    })

    const rewritten = await readFile(
      join(projectRoot, '.claude', 'session_scheduled_tasks.json'),
      'utf-8',
    )
    expect(rewritten).toContain('"manualOnly": true')

    await rm(projectRoot, { recursive: true, force: true })
  })

  test('marks recurring session tasks as fired', () => {
    const store = new DaemonSessionTaskStore()
    store.addTask('/tmp/project', createTask({ recurring: true }))

    expect(store.markTaskFired('/tmp/project', 'task-1', 42)).toBe(true)
    expect(store.getTask('/tmp/project', 'task-1')?.lastFiredAt).toBe(42)
  })
})
