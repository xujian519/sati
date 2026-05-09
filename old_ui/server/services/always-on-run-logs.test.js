import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAlwaysOnRunLog,
  appendAlwaysOnRunLogEvent,
  getAlwaysOnRunLog,
  getRunEventsPath,
  getRunLogPath,
} from './always-on-run-logs.js';

const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run log appends text and reads tail metadata', async () => {
  const projectRoot = await createTempDir('always-on-run-log-');
  await appendAlwaysOnRunLog(projectRoot, 'run-1', ['first line', 'second line']);

  const log = await getAlwaysOnRunLog(projectRoot, 'run-1', { tailBytes: 12 });
  assert.equal(log.content, 'second line\n');
  assert.equal(log.truncated, true);
  assert.equal(log.size, 23);
  assert.ok(log.updatedAt);

  const raw = await fs.readFile(getRunLogPath(projectRoot, 'run-1'), 'utf8');
  assert.equal(raw, 'first line\nsecond line\n');
});

test('run log returns empty metadata when file is missing', async () => {
  const projectRoot = await createTempDir('always-on-run-log-missing-');
  const log = await getAlwaysOnRunLog(projectRoot, 'missing-run');

  assert.deepEqual(log, {
    content: '',
    truncated: false,
    updatedAt: undefined,
    size: 0,
  });
});

test('run log appends structured events', async () => {
  const projectRoot = await createTempDir('always-on-run-log-events-');
  await appendAlwaysOnRunLogEvent(projectRoot, 'run-1', {
    kind: 'plan',
    phase: 'queued',
  });

  const raw = await fs.readFile(getRunEventsPath(projectRoot, 'run-1'), 'utf8');
  const event = JSON.parse(raw.trim());
  assert.equal(event.runId, 'run-1');
  assert.equal(event.kind, 'plan');
  assert.equal(event.phase, 'queued');
  assert.ok(event.timestamp);
});
