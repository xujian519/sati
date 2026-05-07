import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const calls: string[] = []
let shouldFail = false

mock.module('./cronExecutor.js', () => ({
  runCronWorker: async () => {
    calls.push('runCronWorker')
    if (shouldFail) {
      throw new Error('cron failed')
    }
  },
}))

mock.module('../services/analytics/growthbook.js', () => ({
  resetGrowthBook: () => {
    calls.push('resetGrowthBook')
  },
}))

mock.module('../utils/cleanupRegistry.js', () => ({
  runCleanupFunctions: async () => {
    calls.push('runCleanupFunctions')
  },
}))

mock.module('../utils/log.js', () => ({
  logError: (error: unknown) => {
    calls.push(
      `logError:${error instanceof Error ? error.message : String(error)}`,
    )
  },
}))

mock.module('../utils/sessionStorage.js', () => ({
  flushSessionStorage: async () => {
    calls.push('flushSessionStorage')
  },
}))

mock.module('../utils/task/diskOutput.js', () => ({
  waitForPendingTaskOutputOps: async () => {
    calls.push('waitForPendingTaskOutputOps')
  },
}))

const { runDaemonWorker } = await import('./workerRegistry.js')

describe('runDaemonWorker', () => {
  let tempDir: string
  let exitSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cron-daemon-worker-'))
    calls.length = 0
    shouldFail = false
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`)
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true })
  })

  test('flushes and exits cleanly after a successful cron worker run', async () => {
    const payloadPath = join(tempDir, 'payload.json')
    await writeFile(
      payloadPath,
      JSON.stringify({
        projectRoot: '/tmp/project',
        task: {
          id: 'cron-task-1',
          cron: '* * * * *',
          prompt: 'ping',
          createdAt: 1,
          durable: false,
          originSessionId: '11111111-1111-1111-1111-111111111111',
        },
      }),
    )

    await expect(runDaemonWorker(`cron:${payloadPath}`)).rejects.toThrow(
      'process.exit:0',
    )
    await expect(stat(payloadPath)).rejects.toThrow()
    expect(calls).toEqual([
      'runCronWorker',
      'resetGrowthBook',
      'flushSessionStorage',
      'waitForPendingTaskOutputOps',
      'runCleanupFunctions',
      'flushSessionStorage',
      'waitForPendingTaskOutputOps',
    ])
  })

  test('logs failures and exits non-zero after cleanup', async () => {
    shouldFail = true
    const payloadPath = join(tempDir, 'payload.json')
    await writeFile(
      payloadPath,
      JSON.stringify({
        projectRoot: '/tmp/project',
        task: {
          id: 'cron-task-1',
          cron: '* * * * *',
          prompt: 'ping',
          createdAt: 1,
          durable: false,
          originSessionId: '11111111-1111-1111-1111-111111111111',
        },
      }),
    )

    await expect(runDaemonWorker(`cron:${payloadPath}`)).rejects.toThrow(
      'process.exit:1',
    )
    expect(calls).toEqual([
      'runCronWorker',
      'logError:cron failed',
      'resetGrowthBook',
      'flushSessionStorage',
      'waitForPendingTaskOutputOps',
      'runCleanupFunctions',
      'flushSessionStorage',
      'waitForPendingTaskOutputOps',
    ])
  })
})
