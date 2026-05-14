/**
 * Thin adapter — delegates all run-history business logic to
 * `src/always-on/web/AlwaysOnRunHistoryService.ts`.
 *
 * Preserves the original export signatures consumed by routes,
 * discovery-plans, and always-on-slash.
 */

import path from 'node:path';
import { getAlwaysOnRoot } from './always-on-paths.js';
import { getAlwaysOnRunLog } from './always-on-run-logs.js';
import { AlwaysOnRunHistoryService } from '../../../src/always-on/web/AlwaysOnRunHistoryService.js';

// ---------------------------------------------------------------------------
// Wire the service
// ---------------------------------------------------------------------------

function getService() {
  return new AlwaysOnRunHistoryService({
    paths: { getAlwaysOnRoot },
    logs: { getAlwaysOnRunLog },
    sessionMessages: {
      async getSessionMessages(projectName, sessionId, options) {
        const { getSessionMessages } = await import('../projects.js');
        return getSessionMessages(projectName, sessionId, options);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Public API — same signatures as the old module
// ---------------------------------------------------------------------------

export async function appendAlwaysOnRunEvent(projectRoot, event) {
  return getService().appendRunEvent(projectRoot, event);
}

export async function getAlwaysOnRunHistory(projectRoot, { limit, projectName } = {}) {
  return getService().getRunHistory(projectRoot, { limit, projectName });
}

export async function getAlwaysOnRunHistoryDetail(projectRoot, runId, { projectName } = {}) {
  return getService().getRunHistoryDetail(projectRoot, runId, { projectName });
}

export function getRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'run-history.jsonl');
}

export async function readRunHistoryRecords(projectRoot) {
  const result = await getService().getRunHistory(projectRoot, { limit: 500 });
  return result.runs;
}
