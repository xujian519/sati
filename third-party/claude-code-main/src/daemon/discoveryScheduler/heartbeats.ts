import { readdir, readFile, rm } from 'fs/promises'
import { basename } from 'path'
import { getAlwaysOnHeartbeatPath, getAlwaysOnHeartbeatsDir } from '../../utils/alwaysOnPaths.js'
import { safeParseJSON } from '../../utils/json.js'
import type { AlwaysOnHeartbeat } from './types.js'

function isHeartbeat(value: unknown): value is AlwaysOnHeartbeat {
  const candidate = value as AlwaysOnHeartbeat
  return (
    candidate?.schemaVersion === 1 &&
    (candidate.writerKind === 'webui' || candidate.writerKind === 'tui') &&
    typeof candidate.writerId === 'string' &&
    typeof candidate.writtenAt === 'string' &&
    typeof candidate.agentBusy === 'boolean' &&
    Array.isArray(candidate.processingSessionIds) &&
    candidate.processingSessionIds.every(id => typeof id === 'string') &&
    (candidate.lastUserMsgAt === undefined ||
      candidate.lastUserMsgAt === null ||
      typeof candidate.lastUserMsgAt === 'string')
  )
}

function isFresh(writtenAt: string, now: Date, staleAfterMs: number): boolean {
  const timestamp = Date.parse(writtenAt)
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= staleAfterMs
}

export async function readFreshHeartbeats(
  projectRoot: string,
  staleSeconds: number,
  now = new Date(),
): Promise<AlwaysOnHeartbeat[]> {
  let entries: string[]
  try {
    entries = await readdir(getAlwaysOnHeartbeatsDir(projectRoot))
  } catch {
    return []
  }

  const staleAfterMs = staleSeconds * 1000
  const heartbeats: AlwaysOnHeartbeat[] = []
  await Promise.all(
    entries
      .filter(entry => entry.endsWith('.beat'))
      .map(async entry => {
        const path = getAlwaysOnHeartbeatPath(projectRoot, basename(entry))
        const parsed = await readFile(path, 'utf-8')
          .then(raw => safeParseJSON(raw, false))
          .catch(() => null)

        if (!isHeartbeat(parsed) || !isFresh(parsed.writtenAt, now, staleAfterMs)) {
          await rm(path, { force: true }).catch(() => {})
          return
        }
        heartbeats.push(parsed)
      }),
  )

  return heartbeats
}

export function hasBusyHeartbeat(heartbeats: AlwaysOnHeartbeat[]): boolean {
  return heartbeats.some(beat => beat.agentBusy || beat.processingSessionIds.length > 0)
}

export function hasRecentUserMessage(
  heartbeats: AlwaysOnHeartbeat[],
  recentUserMsgMinutes: number,
  now = new Date(),
): boolean {
  const cutoff = now.getTime() - recentUserMsgMinutes * 60_000
  return heartbeats.some(beat => {
    if (!beat.lastUserMsgAt) return false
    const timestamp = Date.parse(beat.lastUserMsgAt)
    return Number.isFinite(timestamp) && timestamp >= cutoff
  })
}
