import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { consumeCronDaemonNotifications } from '../daemon/notificationInbox.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { logError } from '../utils/log.js'

const POLL_INTERVAL_MS = 500

export function useCronDaemonNotificationBridge(enabled: boolean = true): void {
  const sessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!enabled) {
      return
    }

    let disposed = false
    const poll = async () => {
      sessionIdsRef.current.add(getSessionId())

      try {
        await consumeCronDaemonNotifications(
          sessionIdsRef.current,
          notification => {
            if (disposed) {
              return
            }

            enqueuePendingNotification({
              value: notification.message,
              mode: 'task-notification',
              uuid: notification.id,
            })
          },
        )
      } catch (error) {
        logError(error)
      }
    }

    void poll()
    const interval = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    interval.unref?.()

    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [enabled])
}
