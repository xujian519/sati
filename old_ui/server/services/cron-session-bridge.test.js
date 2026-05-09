import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _resetCronSessionBridgeForTest,
  drainSessionCronNotifications,
  registerCronSession,
  unregisterCronSession
} from './cron-session-bridge.js';

async function writeNotification(rootDir, sessionId, notification) {
  const dir = path.join(rootDir, 'cron-daemon', 'notifications', sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${notification.fileId}.json`),
    JSON.stringify(notification),
    'utf-8',
  );
}

afterEach(async () => {
  _resetCronSessionBridgeForTest();
  if (process.env.CLAUDE_CONFIG_DIR) {
    await fs.rm(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  }
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('drainSessionCronNotifications delivers and removes session notifications', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-session-bridge-'));
  process.env.CLAUDE_CONFIG_DIR = rootDir;

  const delivered = [];
  registerCronSession('session-a', async (notification) => {
    delivered.push(notification.message);
  });

  await writeNotification(rootDir, 'session-a', {
    id: '11111111-1111-1111-1111-111111111111',
    fileId: '1-11111111-1111-1111-1111-111111111111',
    sessionId: 'session-a',
    message: '<task-notification>a1</task-notification>',
    createdAt: 1
  });
  await writeNotification(rootDir, 'session-a', {
    id: '22222222-2222-2222-2222-222222222222',
    fileId: '2-22222222-2222-2222-2222-222222222222',
    sessionId: 'session-a',
    message: '<task-notification>a2</task-notification>',
    createdAt: 2
  });

  const consumed = await drainSessionCronNotifications('session-a');
  assert.equal(consumed, 2);
  assert.deepEqual(delivered, [
    '<task-notification>a1</task-notification>',
    '<task-notification>a2</task-notification>'
  ]);

  const remaining = await fs.readdir(path.join(rootDir, 'cron-daemon', 'notifications', 'session-a'));
  assert.deepEqual(remaining, []);
});

test('drainSessionCronNotifications keeps failed notifications on disk', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-session-bridge-'));
  process.env.CLAUDE_CONFIG_DIR = rootDir;

  registerCronSession('session-b', async () => {
    throw new Error('boom');
  });

  await writeNotification(rootDir, 'session-b', {
    id: '33333333-3333-3333-3333-333333333333',
    fileId: '3-33333333-3333-3333-3333-333333333333',
    sessionId: 'session-b',
    message: '<task-notification>b1</task-notification>',
    createdAt: 3
  });

  const consumed = await drainSessionCronNotifications('session-b');
  assert.equal(consumed, 0);

  const remaining = await fs.readdir(path.join(rootDir, 'cron-daemon', 'notifications', 'session-b'));
  assert.deepEqual(remaining, ['3-33333333-3333-3333-3333-333333333333.json']);

  unregisterCronSession('session-b');
});
