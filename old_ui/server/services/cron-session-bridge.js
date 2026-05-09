import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const registeredSessions = new Map();
const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.CLOUDCLI_CRON_NOTIFICATION_POLL_MS, 10) || 500;

let pollInterval = null;
let pollInFlight = false;

function getClaudeConfigHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getCronDaemonNotificationDir() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon', 'notifications');
}

function getCronDaemonSessionNotificationDir(sessionId) {
  return path.join(getCronDaemonNotificationDir(), sessionId);
}

function getCronDaemonSessionNotificationPath(sessionId, notificationId) {
  return path.join(getCronDaemonSessionNotificationDir(sessionId), `${notificationId}.json`);
}

function isCronDaemonNotification(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.fileId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'number'
  );
}

async function readSessionNotifications(sessionId) {
  const dir = getCronDaemonSessionNotificationDir(sessionId);
  let names;
  try {
    names = (await fs.readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    console.error(`[cron-session-bridge] Failed to read notification dir for ${sessionId}:`, error);
    return [];
  }

  const notifications = [];
  for (const name of names) {
    const fileId = name.replace(/\.json$/, '');
    try {
      const raw = await fs.readFile(
        getCronDaemonSessionNotificationPath(sessionId, fileId),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      if (isCronDaemonNotification(parsed)) {
        notifications.push(parsed);
      }
    } catch (error) {
      console.error(
        `[cron-session-bridge] Failed to read notification ${fileId} for ${sessionId}:`,
        error,
      );
    }
  }

  return notifications;
}

async function removeSessionNotifications(sessionId, notificationFileIds) {
  await Promise.all(
    notificationFileIds.map(async (fileId) => {
      try {
        await fs.unlink(getCronDaemonSessionNotificationPath(sessionId, fileId));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return;
        }
        console.error(
          `[cron-session-bridge] Failed to remove notification ${fileId} for ${sessionId}:`,
          error,
        );
      }
    }),
  );
}

async function consumeSessionNotifications(sessionId, onNotification) {
  const notifications = await readSessionNotifications(sessionId);
  if (notifications.length === 0) {
    return 0;
  }

  const completedFileIds = [];
  for (const notification of notifications) {
    try {
      await onNotification(notification);
      completedFileIds.push(notification.fileId);
    } catch (error) {
      console.error(
        `[cron-session-bridge] Failed to handle notification ${notification.fileId} for ${sessionId}:`,
        error,
      );
      break;
    }
  }

  if (completedFileIds.length > 0) {
    await removeSessionNotifications(sessionId, completedFileIds);
  }

  return completedFileIds.length;
}

async function pollRegisteredSessions() {
  if (pollInFlight) {
    return 0;
  }

  pollInFlight = true;
  try {
    let deliveredCount = 0;
    for (const [sessionId, onNotification] of registeredSessions.entries()) {
      deliveredCount += await consumeSessionNotifications(sessionId, onNotification);
    }
    return deliveredCount;
  } finally {
    pollInFlight = false;
  }
}

function ensurePollerStarted() {
  if (pollInterval) {
    return;
  }

  pollInterval = setInterval(() => {
    void pollRegisteredSessions();
  }, DEFAULT_POLL_INTERVAL_MS);
  pollInterval.unref?.();
}

function maybeStopPoller() {
  if (registeredSessions.size > 0 || !pollInterval) {
    return;
  }

  clearInterval(pollInterval);
  pollInterval = null;
}

function registerCronSession(sessionId, onNotification) {
  if (!sessionId || typeof onNotification !== 'function') {
    return;
  }

  registeredSessions.set(sessionId, onNotification);
  ensurePollerStarted();
}

function unregisterCronSession(sessionId) {
  registeredSessions.delete(sessionId);
  maybeStopPoller();
}

async function drainSessionCronNotifications(sessionId) {
  const onNotification = registeredSessions.get(sessionId);
  if (!onNotification) {
    return 0;
  }

  return await consumeSessionNotifications(sessionId, onNotification);
}

function _resetCronSessionBridgeForTest() {
  registeredSessions.clear();
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  pollInFlight = false;
}

export {
  drainSessionCronNotifications,
  registerCronSession,
  unregisterCronSession,
  _resetCronSessionBridgeForTest,
};
