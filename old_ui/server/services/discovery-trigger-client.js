import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

function getClaudeConfigHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getDiscoveryRequestsDir() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon', 'discovery-requests');
}

async function ack(projectRoot, status) {
  try {
    await sendCronDaemonRequest({ type: 'discovery_fire_complete', projectRoot, status });
  } catch {
    // Best effort; daemon will retry after the lock is released by a later ack or manual cleanup.
  }
}

export function startDiscoveryTriggerClient({ clients, getWriterId, intervalMs = 5000 }) {
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      let entries = [];
      try {
        entries = await fs.readdir(getDiscoveryRequestsDir());
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const requestPath = path.join(getDiscoveryRequestsDir(), entry);
        const request = await fs.readFile(requestPath, 'utf8')
          .then((raw) => JSON.parse(raw))
          .catch(() => null);
        if (!request?.requestId || request.targetWriterKind !== 'webui') {
          continue;
        }

        const target = [...clients].find((client) =>
          client.readyState === WebSocket.OPEN &&
          getWriterId(client) === request.targetWriterId
        );

        if (!target) {
          await ack(request.projectRoot, 'failed');
          await fs.rm(requestPath, { force: true }).catch(() => {});
          continue;
        }

        target.send(JSON.stringify({
          type: 'always-on-auto-discovery-start',
          requestId: request.requestId,
          projectRoot: request.projectRoot,
        }));
        await fs.rm(requestPath, { force: true }).catch(() => {});
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
