import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { useEffect } from 'react'
import { requestCronDaemon } from '../daemon/client.js'
import { getCronDaemonDiscoveryRequestsDir } from '../daemon/paths.js'
import { logForDebugging } from '../utils/debug.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { buildAlwaysOnDiscoveryPrompt } from '../utils/alwaysOnDiscoveryPrompt.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { WORKLOAD_CRON } from '../utils/workloadContext.js'

const POLL_INTERVAL_MS = 5_000

export function useAlwaysOnDiscoveryRequests(): void {
  useEffect(() => {
    const projectRoot = getProjectRoot()
    let running = false

    const ack = async (status: 'started' | 'failed') => {
      await requestCronDaemon({
        type: 'discovery_fire_complete',
        projectRoot,
        status,
      }).catch(error =>
        logForDebugging(
          `[AlwaysOnDiscoveryRequests] ack failed: ${String(error)}`,
        ),
      )
    }

    const poll = async () => {
      if (running) return
      running = true
      try {
        const entries = await readdir(getCronDaemonDiscoveryRequestsDir()).catch(
          () => [],
        )
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue
          const requestPath = join(getCronDaemonDiscoveryRequestsDir(), entry)
          const request = await readFile(requestPath, 'utf-8')
            .then(raw => JSON.parse(raw))
            .catch(() => null)
          if (
            request?.targetWriterKind !== 'tui' ||
            request.targetWriterId !== String(process.pid) ||
            request.projectRoot !== projectRoot
          ) {
            continue
          }

          enqueuePendingNotification({
            value: buildAlwaysOnDiscoveryPrompt(projectRoot),
            mode: 'prompt',
            priority: 'later',
            isMeta: true,
            workload: WORKLOAD_CRON,
          })
          await ack('started')
          await rm(requestPath, { force: true }).catch(() => {})
        }
      } catch (error) {
        logForDebugging(
          `[AlwaysOnDiscoveryRequests] poll failed: ${String(error)}`,
        )
      } finally {
        running = false
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    timer.unref()
    return () => clearInterval(timer)
  }, [])
}
