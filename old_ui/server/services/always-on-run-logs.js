import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getAlwaysOnRoot } from './always-on-paths.js';

const DEFAULT_TAIL_BYTES = 60_000;
const MAX_TAIL_BYTES = 512_000;

function normalizeRunId(runId) {
  return typeof runId === 'string'
    ? runId.trim().replace(/[^a-zA-Z0-9._:-]/g, '-')
    : '';
}

function normalizeTailBytes(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TAIL_BYTES;
  }
  return Math.min(parsed, MAX_TAIL_BYTES);
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}

export function getRunLogPath(projectRoot, runId) {
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId) {
    throw new Error('runId is required');
  }
  return path.join(getAlwaysOnRunsDir(projectRoot), `${safeRunId}.log`);
}

export function getRunEventsPath(projectRoot, runId) {
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId) {
    throw new Error('runId is required');
  }
  return path.join(getAlwaysOnRunsDir(projectRoot), `${safeRunId}.events.jsonl`);
}

export function formatAlwaysOnPlanLogLine({
  timestamp = new Date().toISOString(),
  level = 'info',
  runId,
  planId,
  phase,
  message,
}) {
  const safeMessage = String(message || '').replace(/\s+/g, ' ').trim();
  return `[AlwaysOnPlanRun] ts=${timestamp} level=${level} runId=${runId} planId=${planId} phase=${phase} message=${JSON.stringify(safeMessage)}`;
}

export async function appendAlwaysOnRunLog(projectRoot, runId, lines) {
  const values = Array.isArray(lines) ? lines : [lines];
  const content = values
    .map((line) => (typeof line === 'string' ? line : String(line ?? '')))
    .filter((line) => line.length > 0)
    .map(ensureTrailingNewline)
    .join('');

  if (!content) {
    return;
  }

  await fs.mkdir(getAlwaysOnRunsDir(projectRoot), { recursive: true });
  await fs.appendFile(getRunLogPath(projectRoot, runId), content, 'utf8');
}

export async function appendAlwaysOnRunLogEvent(projectRoot, runId, event) {
  await fs.mkdir(getAlwaysOnRunsDir(projectRoot), { recursive: true });
  await fs.appendFile(
    getRunEventsPath(projectRoot, runId),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
      runId,
    })}\n`,
    'utf8',
  );
}

export async function getAlwaysOnRunLog(projectRoot, runId, { tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  const safeTailBytes = normalizeTailBytes(tailBytes);
  let stats;
  try {
    stats = await fs.stat(getRunLogPath(projectRoot, runId));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        content: '',
        truncated: false,
        updatedAt: undefined,
        size: 0,
      };
    }
    throw error;
  }

  if (stats.size === 0) {
    return {
      content: '',
      truncated: false,
      updatedAt: stats.mtime.toISOString(),
      size: 0,
    };
  }

  const start = Math.max(0, stats.size - safeTailBytes);
  const length = stats.size - start;
  const handle = await fs.open(getRunLogPath(projectRoot, runId), 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      content: buffer.toString('utf8'),
      truncated: start > 0,
      updatedAt: stats.mtime.toISOString(),
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}
