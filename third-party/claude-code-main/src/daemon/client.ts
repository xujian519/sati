import { spawn } from 'child_process'
import { mkdir, open, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import {
  persistRequestedCronDaemonOwner,
  reconcileCronDaemonOwnerForCurrentProcess,
} from './ownership.js'
import { assertCronDaemonOk, sendCronDaemonRequest } from './ipc.js'
import { getCronDaemonStartLockPath } from './paths.js'
import { getDaemonCommandArgs } from './spawn.js'
import { ensureTuiCronDaemonClientLease } from './tuiClientLease.js'
import type { CronDaemonRequest, CronDaemonResponse } from './types.js'

const START_LOCK_STALE_MS = 30_000
const CCR_SENTINEL = 'http://ccr.local'
const CCR_DAEMON_FETCH_INTERCEPTOR = 'CCR_DAEMON_FETCH_INTERCEPTOR'

export function buildCronDaemonEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  if (env.ANTHROPIC_BASE_URL === CCR_SENTINEL) {
    env[CCR_DAEMON_FETCH_INTERCEPTOR] = '1'
  }
  return env
}

function isDaemonUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error &&
      (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function acquireStartLock(): Promise<(() => Promise<void>) | null> {
  const lockPath = getCronDaemonStartLockPath()
  await mkdir(dirname(lockPath), { recursive: true })
  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(`${process.pid}\n`, 'utf-8')
    await handle.close()
    return async () => {
      await rm(lockPath, { force: true }).catch(() => {})
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
  }

  const ageMs = await stat(lockPath)
    .then(stats => Date.now() - stats.mtimeMs)
    .catch(() => 0)
  if (ageMs > START_LOCK_STALE_MS) {
    await rm(lockPath, { force: true }).catch(() => {})
    return await acquireStartLock()
  }
  return null
}

async function pingCronDaemon(): Promise<void> {
  const response = await sendCronDaemonRequest({ type: 'ping' })
  assertCronDaemonOk(response)
}

async function startCronDaemonDetached(): Promise<void> {
  const child = spawn(process.execPath, getDaemonCommandArgs(), {
    cwd: process.cwd(),
    env: buildCronDaemonEnv(),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function waitForHealthyDaemon(attempts = 20): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await pingCronDaemon()
      await persistRequestedCronDaemonOwner()
      return
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Cron daemon failed to start')
}

export async function ensureCronDaemon(): Promise<void> {
  try {
    await pingCronDaemon()
    await reconcileCronDaemonOwnerForCurrentProcess()
    return
  } catch (error) {
    if (!isDaemonUnavailableError(error)) {
      throw error
    }
  }

  const releaseStartLock = await acquireStartLock()
  if (releaseStartLock) {
    try {
      try {
        await pingCronDaemon()
        return
      } catch {
        // We own startup now; any unhealthy ping means this process should spawn.
      }

      await startCronDaemonDetached()
      await waitForHealthyDaemon()
      return
    } finally {
      await releaseStartLock()
    }
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await pingCronDaemon()
      await reconcileCronDaemonOwnerForCurrentProcess()
      return
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }

  const releaseAfterTimeout = await acquireStartLock()
  if (releaseAfterTimeout) {
    try {
      await startCronDaemonDetached()
      await waitForHealthyDaemon()
      return
    } finally {
      await releaseAfterTimeout()
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Cron daemon failed to start')
}

export async function requestCronDaemon(
  request: CronDaemonRequest,
): Promise<CronDaemonResponse> {
  await ensureCronDaemon()
  if ('projectRoot' in request && typeof request.projectRoot === 'string') {
    ensureTuiCronDaemonClientLease(request.projectRoot)
  }
  return await sendCronDaemonRequest(request)
}
