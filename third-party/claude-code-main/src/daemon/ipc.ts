import net from 'net'
import { getCronDaemonSocketPath } from './paths.js'
import type { CronDaemonRequest, CronDaemonResponse } from './types.js'
import { safeParseJSON } from '../utils/json.js'

const DEFAULT_TIMEOUT_MS = 5_000

export async function sendCronDaemonRequest(
  request: CronDaemonRequest,
  socketPath = getCronDaemonSocketPath(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CronDaemonResponse> {
  return await new Promise<CronDaemonResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    let buffer = ''

    const finishWithResponse = (value: CronDaemonResponse) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    const finishWithError = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    const timer = setTimeout(() => {
      finishWithError(new Error('Timed out waiting for Cron daemon response'))
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })

    socket.on('data', chunk => {
      buffer += chunk.toString('utf-8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      clearTimeout(timer)
      const line = buffer.slice(0, newlineIndex)
      const parsed = safeParseJSON(line, false)
      if (!parsed) {
        finishWithError(new Error('Cron daemon returned invalid JSON'))
        return
      }
      finishWithResponse(parsed as CronDaemonResponse)
    })

    socket.on('error', error => {
      clearTimeout(timer)
      finishWithError(error)
    })

    socket.on('end', () => {
      clearTimeout(timer)
      if (!settled) {
        finishWithError(new Error('Cron daemon closed the connection early'))
      }
    })
  })
}

export function assertCronDaemonOk(
  response: CronDaemonResponse,
): asserts response is Extract<CronDaemonResponse, { ok: true }> {
  if (!response.ok) {
    throw new Error(response.error)
  }
}
