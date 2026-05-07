import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { useEffect, useRef } from 'react'
import { requestCronDaemon } from '../daemon/client.js'
import { getAlwaysOnHeartbeatPath } from '../utils/alwaysOnPaths.js'
import { logForDebugging } from '../utils/debug.js'
import { getProjectRoot } from '../bootstrap/state.js'
import type { Task } from '../utils/tasks.js'

const HEARTBEAT_INTERVAL_MS = 30_000

function hasIncompleteTask(tasks: Task[] | undefined): boolean {
  return Boolean(tasks?.some(task => task.status !== 'completed'))
}

export function useAlwaysOnHeartbeat(tasks: Task[] | undefined): void {
  const lastUserMsgAtRef = useRef<string | null>(null)
  const wasBusyRef = useRef(false)

  useEffect(() => {
    const projectRoot = getProjectRoot()
    const filePath = getAlwaysOnHeartbeatPath(projectRoot, `tui-${process.pid}.beat`)

    const writeBeat = async () => {
      const agentBusy = hasIncompleteTask(tasks)
      if (agentBusy && !wasBusyRef.current) {
        lastUserMsgAtRef.current = new Date().toISOString()
      }
      wasBusyRef.current = agentBusy

      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            writerKind: 'tui',
            writerId: String(process.pid),
            writtenAt: new Date().toISOString(),
            agentBusy,
            processingSessionIds: [],
            lastUserMsgAt: lastUserMsgAtRef.current,
          },
          null,
          2,
        ),
        'utf-8',
      )
      await requestCronDaemon({ type: 'register_project', projectRoot }).catch(
        error => {
          logForDebugging(
            `[AlwaysOnHeartbeat] register_project failed: ${String(error)}`,
          )
        },
      )
    }

    void writeBeat().catch(error =>
      logForDebugging(`[AlwaysOnHeartbeat] write failed: ${String(error)}`),
    )
    const timer = setInterval(() => {
      void writeBeat().catch(error =>
        logForDebugging(`[AlwaysOnHeartbeat] write failed: ${String(error)}`),
      )
    }, HEARTBEAT_INTERVAL_MS)
    timer.unref()

    return () => {
      clearInterval(timer)
      void rm(filePath, { force: true })
    }
  }, [tasks])
}
