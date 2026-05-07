import { randomUUID, type UUID } from 'crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { getCronDaemonSessionNotificationDir, getCronDaemonSessionNotificationPath } from './paths.js'
import { getErrnoCode } from '../utils/errors.js'
import { safeParseJSON } from '../utils/json.js'
import { logError } from '../utils/log.js'
import { jsonStringify } from '../utils/slowOperations.js'

export type CronDaemonNotification = {
  id: UUID
  fileId: string
  sessionId: string
  message: string
  createdAt: number
}

function isCronDaemonNotification(
  value: unknown,
): value is CronDaemonNotification {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'fileId' in value &&
    typeof value.fileId === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'number'
  )
}

export async function enqueueCronDaemonNotification(
  sessionId: string,
  message: string,
): Promise<CronDaemonNotification> {
  const id = randomUUID() as UUID
  const createdAt = Date.now()
  const notification: CronDaemonNotification = {
    id,
    fileId: `${createdAt}-${id}`,
    sessionId,
    message,
    createdAt,
  }
  const dir = getCronDaemonSessionNotificationDir(sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    getCronDaemonSessionNotificationPath(sessionId, notification.fileId),
    jsonStringify(notification, null, 2) + '\n',
    'utf-8',
  )
  return notification
}

export async function readCronDaemonNotifications(
  sessionId: string,
): Promise<CronDaemonNotification[]> {
  try {
    const dir = getCronDaemonSessionNotificationDir(sessionId)
    const names = (await readdir(dir))
      .filter(name => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))

    const notifications = await Promise.all(
      names.map(async name => {
        try {
          const fileId = name.replace(/\.json$/, '')
          const parsed = safeParseJSON(
            await readFile(
              getCronDaemonSessionNotificationPath(sessionId, fileId),
              'utf-8',
            ),
            false,
          )
          return isCronDaemonNotification(parsed) ? parsed : null
        } catch (error) {
          logError(error)
          return null
        }
      }),
    )

    return notifications.filter(notification => notification !== null)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return []
    }
    logError(error)
    return []
  }
}

export async function removeCronDaemonNotifications(
  sessionId: string,
  notificationFileIds: readonly string[],
): Promise<void> {
  await Promise.all(
    notificationFileIds.map(fileId =>
      unlink(getCronDaemonSessionNotificationPath(sessionId, fileId)).catch(
        error => {
          if (getErrnoCode(error) === 'ENOENT') {
            return
          }
          logError(error)
        },
      ),
    ),
  )
}

export async function consumeCronDaemonNotifications(
  sessionIds: Iterable<string>,
  onNotification: (notification: CronDaemonNotification) => void,
): Promise<number> {
  let deliveredCount = 0

  for (const sessionId of sessionIds) {
    const notifications = await readCronDaemonNotifications(sessionId)
    if (notifications.length === 0) {
      continue
    }

    for (const notification of notifications) {
      onNotification(notification)
    }

    await removeCronDaemonNotifications(
      sessionId,
      notifications.map(notification => notification.fileId),
    )
    deliveredCount += notifications.length
  }

  return deliveredCount
}
