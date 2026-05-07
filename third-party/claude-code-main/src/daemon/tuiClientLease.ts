import { randomUUID } from 'crypto'
import { sendCronDaemonRequest } from './ipc.js'
import {
  startCronDaemonClientLease,
  type RequestCronDaemonFn,
} from './clientLeaseController.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'

type TuiLeaseHandle = {
  stop: () => Promise<void>
  refresh: () => Promise<void>
  addProjectRoot: (projectRoot: string) => void
}

let leaseHandle: TuiLeaseHandle | null = null
let unregisterCleanup: (() => void) | null = null

type EnsureTuiLeaseOptions = {
  force?: boolean
  requestCronDaemonFn?: RequestCronDaemonFn
  registerCleanupFn?: typeof registerCleanup
}

function shouldRegisterTuiLease(force = false): boolean {
  if (force) return true
  if (!process.stdout.isTTY) return false
  if (process.argv.includes('-p') || process.argv.includes('--print')) return false
  if (process.argv.includes('--daemon-worker')) return false
  return true
}

export function ensureTuiCronDaemonClientLease(
  projectRoot: string,
  options: EnsureTuiLeaseOptions = {},
): void {
  if (!shouldRegisterTuiLease(options.force)) return

  if (leaseHandle) {
    leaseHandle.addProjectRoot(projectRoot)
    void leaseHandle.refresh().catch(error =>
      logForDebugging(`[CronDaemonClientLease] refresh failed: ${String(error)}`),
    )
    return
  }

  const projectRoots = new Set<string>([projectRoot])
  const lease = startCronDaemonClientLease({
    clientId: `tui:${process.pid}:${randomUUID()}`,
    clientKind: 'tui',
    processId: process.pid,
    getProjectRoots: () => [...projectRoots],
    requestCronDaemonFn: options.requestCronDaemonFn ?? sendCronDaemonRequest,
    onError: error =>
      logForDebugging(`[CronDaemonClientLease] request failed: ${String(error)}`),
  })

  leaseHandle = {
    stop: lease.stop,
    refresh: lease.refresh,
    addProjectRoot(root: string) {
      projectRoots.add(root)
    },
  }

  unregisterCleanup = (options.registerCleanupFn ?? registerCleanup)(async () => {
    await stopTuiCronDaemonClientLease()
  })
}

export async function stopTuiCronDaemonClientLease(): Promise<void> {
  const handle = leaseHandle
  leaseHandle = null
  unregisterCleanup?.()
  unregisterCleanup = null
  if (!handle) return
  await handle.stop()
}

export function resetTuiCronDaemonClientLeaseForTest(): void {
  leaseHandle = null
  unregisterCleanup?.()
  unregisterCleanup = null
}
