import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getAlwaysOnDiscoveryStatePath } from '../../utils/alwaysOnPaths.js'
import { safeParseJSON } from '../../utils/json.js'
import type { DiscoveryFireStatus, DiscoveryState } from './types.js'

export function getDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function defaultDiscoveryState(now = new Date()): DiscoveryState {
  return {
    schemaVersion: 1,
    todayKey: getDayKey(now),
    todayRunCount: 0,
    consecutiveFailures: 0,
  }
}

function normalizeState(value: unknown, now = new Date()): DiscoveryState {
  const state = value as DiscoveryState
  if (!state || state.schemaVersion !== 1 || typeof state !== 'object') {
    return defaultDiscoveryState(now)
  }
  return {
    schemaVersion: 1,
    lastFireStartedAt:
      typeof state.lastFireStartedAt === 'string'
        ? state.lastFireStartedAt
        : undefined,
    lastFireCompletedAt:
      typeof state.lastFireCompletedAt === 'string'
        ? state.lastFireCompletedAt
        : undefined,
    todayKey: typeof state.todayKey === 'string' ? state.todayKey : getDayKey(now),
    todayRunCount:
      typeof state.todayRunCount === 'number' && state.todayRunCount >= 0
        ? state.todayRunCount
        : 0,
    consecutiveFailures:
      typeof state.consecutiveFailures === 'number' && state.consecutiveFailures >= 0
        ? state.consecutiveFailures
        : 0,
  }
}

function resetDailyBudgetIfNeeded(
  state: DiscoveryState,
  now = new Date(),
): DiscoveryState {
  const todayKey = getDayKey(now)
  if (state.todayKey === todayKey) return state
  return {
    ...state,
    todayKey,
    todayRunCount: 0,
  }
}

export async function readDiscoveryState(
  projectRoot: string,
  now = new Date(),
): Promise<DiscoveryState> {
  const path = getAlwaysOnDiscoveryStatePath(projectRoot)
  const parsed = await readFile(path, 'utf-8')
    .then(raw => safeParseJSON(raw, false))
    .catch(() => null)
  return resetDailyBudgetIfNeeded(normalizeState(parsed, now), now)
}

export async function writeDiscoveryState(
  projectRoot: string,
  state: DiscoveryState,
): Promise<void> {
  const path = getAlwaysOnDiscoveryStatePath(projectRoot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8')
}

export async function markDiscoveryFireStarted(
  projectRoot: string,
  now = new Date(),
): Promise<DiscoveryState> {
  const current = await readDiscoveryState(projectRoot, now)
  const next: DiscoveryState = {
    ...current,
    lastFireStartedAt: now.toISOString(),
    todayKey: getDayKey(now),
    todayRunCount: current.todayRunCount + 1,
  }
  await writeDiscoveryState(projectRoot, next)
  return next
}

export async function markDiscoveryFireComplete(
  projectRoot: string,
  status: DiscoveryFireStatus,
  now = new Date(),
): Promise<DiscoveryState> {
  const current = await readDiscoveryState(projectRoot, now)
  const next: DiscoveryState = {
    ...current,
    lastFireCompletedAt: now.toISOString(),
    consecutiveFailures: status === 'failed' ? current.consecutiveFailures + 1 : 0,
  }
  await writeDiscoveryState(projectRoot, next)
  return next
}
