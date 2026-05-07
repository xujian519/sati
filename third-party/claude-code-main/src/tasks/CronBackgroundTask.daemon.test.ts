import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { lstat, mkdtemp, readFile, readlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../state/AppState.js'
import {
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import { flushSessionStorage, getAgentTranscriptPath } from '../utils/sessionStorage.js'
import {
  _resetTaskOutputDirForTest,
  getTaskOutputPath,
  waitForPendingTaskOutputOps,
} from '../utils/task/diskOutput.js'
import { createCronScheduler } from '../utils/cronScheduler.js'
import { readCronTasks, writeCronTasks } from '../utils/cronTasks.js'
import { sleep } from '../utils/sleep.js'

mock.module('../query.js', () => ({
  async *query() {},
}))

const { startCronBackgroundTask } = await import('./CronBackgroundTask.js')

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }
    await sleep(50)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

describe('CronBackgroundTask daemon mode', () => {
  let projectRoot: string
  let configDir: string
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'cron-daemon-config-'))
    projectRoot = await mkdtemp(join(tmpdir(), 'cron-daemon-project-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    _resetTaskOutputDirForTest()
    setOriginalCwd(projectRoot)
    setProjectRoot(projectRoot)
    setCwdState(projectRoot)
    setIsInteractive(false)
  })

  afterEach(async () => {
    await flushSessionStorage()
    await waitForPendingTaskOutputOps()
    setSessionPersistenceDisabled(false)
    _resetTaskOutputDirForTest()
    if (priorConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = priorConfigDir
    }
    await rm(projectRoot, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  })

  test('persists sidechain transcript and output link with session persistence disabled', async () => {
    const originSessionId = randomUUID() as UUID
    switchSession(asSessionId(originSessionId))
    setSessionPersistenceDisabled(true)

    let appState = { tasks: {} } as AppState
    const notifications: string[] = []

    const result = await startCronBackgroundTask({
      task: {
        id: 'cron-task-1',
        cron: '* * * * *',
        prompt: 'cron daemon smoke test',
        createdAt: Date.now(),
        durable: false,
        originSessionId,
      },
      setAppState: updater => {
        appState = updater(appState)
      },
      notificationSink: async message => {
        notifications.push(message)
      },
      createQueryParams: async () =>
        ({
          toolUseContext: {
            options: {
              tools: [],
            },
          },
        }) as any,
    })

    expect(result.status).toBe('started')
    if (result.status !== 'started') {
      return
    }

    await result.completion
    await flushSessionStorage()
    await waitForPendingTaskOutputOps()

    const transcriptPath = getAgentTranscriptPath(asAgentId(result.transcriptKey))
    const transcript = await readFile(transcriptPath, 'utf-8')
    expect(transcript).toContain('cron daemon smoke test')

    const outputPath = getTaskOutputPath(result.runtimeTaskId)
    const outputStat = await lstat(outputPath)
    expect(outputStat.isSymbolicLink()).toBe(true)
    expect(await readlink(outputPath)).toBe(transcriptPath)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('<task-notification>')
    expect(notifications[0]).toContain(outputPath)
  })

  test('scheduler preserves transcriptKey and lastFiredAt for durable recurring daemon tasks', async () => {
    const originSessionId = randomUUID() as UUID
    const taskId = 'deadbeef'
    let appState = { tasks: {} } as AppState
    const notifications: string[] = []
    const startedRuns: Array<{
      transcriptKey: string
      completion: Promise<void>
    }> = []

    await writeCronTasks(
      [
        {
          id: taskId,
          cron: '* * * * *',
          prompt: 'durable cron daemon smoke test',
          createdAt: Date.now() - 5 * 60_000,
          recurring: true,
          originSessionId,
        },
      ],
      projectRoot,
    )

    const scheduler = createCronScheduler({
      dir: projectRoot,
      onFire: () => {},
      onFireTask: async task => {
        const result = await startCronBackgroundTask({
          task: {
            ...task,
            durable: true,
          },
          dir: projectRoot,
          setAppState: updater => {
            appState = updater(appState)
          },
          notificationSink: async message => {
            notifications.push(message)
          },
          createQueryParams: async () =>
            ({
              toolUseContext: {
                options: {
                  tools: [],
                },
              },
            }) as any,
        })

        if (result.status === 'started') {
          startedRuns.push({
            transcriptKey: result.transcriptKey,
            completion: result.completion,
          })
        }
      },
    })

    try {
      scheduler.start()

      await waitForCondition(() => startedRuns.length === 1, 4000)
      await Promise.all(startedRuns.map(run => run.completion))
      await flushSessionStorage()
      await waitForPendingTaskOutputOps()
      await waitForCondition(async () => {
        const [storedTask] = await readCronTasks(projectRoot)
        return Boolean(
          storedTask &&
            typeof storedTask.lastFiredAt === 'number' &&
            storedTask.transcriptKey === startedRuns[0]?.transcriptKey &&
            notifications.length === 1,
        )
      }, 4000)
    } finally {
      scheduler.stop()
    }

    const [storedTask] = await readCronTasks(projectRoot)
    expect(startedRuns).toHaveLength(1)
    const startedRun = startedRuns[0]!

    expect(storedTask).toMatchObject({
      id: taskId,
      recurring: true,
      originSessionId,
      transcriptKey: startedRun.transcriptKey,
      lastFiredAt: expect.any(Number),
    })
    expect(notifications).toHaveLength(1)

    const transcriptPath = getAgentTranscriptPath(
      asAgentId(startedRun.transcriptKey),
    )
    const transcript = await readFile(transcriptPath, 'utf-8')
    expect(transcript).toContain('durable cron daemon smoke test')
  })

  test('persists transcriptKey for durable recurring tasks without an explicit daemon dir', async () => {
    const originSessionId = randomUUID() as UUID
    const taskId = 'feedface'
    let appState = { tasks: {} } as AppState

    switchSession(asSessionId(originSessionId))
    await writeCronTasks(
      [
        {
          id: taskId,
          cron: '* * * * *',
          prompt: 'durable repl smoke test',
          createdAt: Date.now(),
          recurring: true,
          originSessionId,
        },
      ],
      projectRoot,
    )

    const [task] = await readCronTasks(projectRoot)
    expect(task).toBeDefined()
    if (!task) {
      return
    }
    const result = await startCronBackgroundTask({
      task: {
        ...task,
        durable: true,
      },
      setAppState: updater => {
        appState = updater(appState)
      },
      createQueryParams: async () =>
        ({
          toolUseContext: {
            options: {
              tools: [],
            },
          },
        }) as any,
    })

    expect(result.status).toBe('started')
    if (result.status !== 'started') {
      return
    }

    await result.completion
    await flushSessionStorage()
    await waitForPendingTaskOutputOps()

    const [storedTask] = await readCronTasks(projectRoot)
    expect(storedTask).toMatchObject({
      id: taskId,
      recurring: true,
      originSessionId,
      transcriptKey: result.transcriptKey,
    })

    const transcriptPath = getAgentTranscriptPath(asAgentId(result.transcriptKey))
    const transcript = await readFile(transcriptPath, 'utf-8')
    expect(transcript).toContain('durable repl smoke test')
  })
})
