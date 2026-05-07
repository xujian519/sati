import { readFile, unlink } from 'fs/promises'
import type { CronWorkerPayload } from './types.js'
import { safeParseJSON } from '../utils/json.js'
import { enableConfigs } from '../utils/config.js'
import { runCronWorker } from './cronExecutor.js'
import { resetGrowthBook } from '../services/analytics/growthbook.js'
import { runCleanupFunctions } from '../utils/cleanupRegistry.js'
import { logError } from '../utils/log.js'
import { flushSessionStorage } from '../utils/sessionStorage.js'
import { waitForPendingTaskOutputOps } from '../utils/task/diskOutput.js'

function parseWorkerSpec(spec: string | undefined): { kind: string; value: string } {
  if (!spec) {
    throw new Error('Missing daemon worker spec')
  }
  const separatorIndex = spec.indexOf(':')
  if (separatorIndex === -1) {
    throw new Error(`Invalid daemon worker spec: ${spec}`)
  }
  return {
    kind: spec.slice(0, separatorIndex),
    value: spec.slice(separatorIndex + 1),
  }
}

export async function runDaemonWorker(spec?: string): Promise<void> {
  let exitCode = 0

  try {
    const { kind, value } = parseWorkerSpec(spec)
    enableConfigs()

    switch (kind) {
      case 'cron': {
        const raw = await readFile(value, 'utf-8')
        try {
          const parsed = safeParseJSON(raw, false)
          if (!parsed) {
            throw new Error(`Invalid cron worker payload: ${value}`)
          }
          await runCronWorker(parsed as CronWorkerPayload)
        } finally {
          await unlink(value).catch(() => {})
        }
        return
      }
      default:
        throw new Error(`Unknown daemon worker kind: ${kind}`)
    }
  } catch (error) {
    exitCode = 1
    logError(error)
  } finally {
    try {
      resetGrowthBook()
      await flushSessionStorage()
      await waitForPendingTaskOutputOps()
      await runCleanupFunctions()
      await flushSessionStorage()
      await waitForPendingTaskOutputOps()
    } catch (error) {
      exitCode = 1
      logError(error)
    } finally {
      process.exit(exitCode)
    }
  }
}
