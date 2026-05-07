import { sendCronDaemonRequest } from './ipc.js'
import type {
  CronDaemonClientKind,
  CronDaemonRequest,
  CronDaemonResponse,
} from './types.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_STOP_TIMEOUT_MS = 1_500

export type RequestCronDaemonFn = (
  request: CronDaemonRequest,
) => Promise<CronDaemonResponse>

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function startCronDaemonClientLease(options: {
  clientId: string
  clientKind: CronDaemonClientKind
  processId?: number
  projectRoots?: string[]
  getProjectRoots?: () => string[]
  intervalMs?: number
  stopTimeoutMs?: number
  requestCronDaemonFn?: RequestCronDaemonFn
  onError?: (error: unknown) => void
}): { stop: () => Promise<void>; refresh: () => Promise<void> } {
  const {
    clientId,
    clientKind,
    processId,
    projectRoots = [],
    getProjectRoots = () => projectRoots,
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    requestCronDaemonFn = sendCronDaemonRequest,
    onError,
  } = options
  let registered = false
  let stopped = false
  let stopPromise: Promise<void> | null = null

  const register = async (): Promise<void> => {
    if (stopped) return
    const response = await requestCronDaemonFn({
      type: 'register_client',
      clientId,
      clientKind,
      ...(typeof processId === 'number' ? { processId } : {}),
      projectRoots: getProjectRoots(),
    })
    if (stopped) {
      if (response.ok) {
        await requestCronDaemonFn({ type: 'unregister_client', clientId }).catch(
          error => onError?.(error),
        )
      }
      return
    }
    registered = response.ok
  }

  const heartbeat = async (): Promise<void> => {
    if (stopped) return
    if (!registered) {
      await register()
      return
    }

    const response: CronDaemonResponse = await requestCronDaemonFn({
      type: 'client_heartbeat',
      clientId,
      projectRoots: getProjectRoots(),
    })
    if (!response.ok) {
      registered = false
      await register()
    }
  }

  const registerPromise = register().catch(error => {
    registered = false
    onError?.(error)
  })

  const timer = setInterval(() => {
    void heartbeat().catch(error => {
      registered = false
      onError?.(error)
    })
  }, intervalMs)
  timer.unref()

  return {
    async refresh() {
      await heartbeat()
    },
    async stop() {
      if (stopPromise) return await stopPromise
      stopPromise = (async () => {
        stopped = true
        clearInterval(timer)
        await registerPromise
        await withTimeout(
          requestCronDaemonFn({
            type: 'unregister_client',
            clientId,
          }).then(() => {
            registered = false
          }),
          stopTimeoutMs,
          () => {
            registered = false
          },
        ).catch(error => onError?.(error))
      })()
      return await stopPromise
    },
  }
}
