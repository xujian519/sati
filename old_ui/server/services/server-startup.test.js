import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runServerStartupBeforeListen,
  startServerAfterStartup
} from './server-startup.js';

test('runServerStartupBeforeListen does not start the cron daemon without a UI page', async () => {
  const steps = [];

  await runServerStartupBeforeListen({
    initializeDatabaseFn: async () => {
      steps.push('database');
    },
    ensureLocalUserWhenAuthDisabledFn: async () => {
      steps.push('local-user');
    },
    configureWebPushFn: () => {
      steps.push('web-push');
    }
  });

  assert.deepEqual(steps, ['database', 'local-user', 'web-push']);
});

test('startServerAfterStartup does not continue into listen when startup fails', async () => {
  let listenCalled = false;

  await assert.rejects(
    () => startServerAfterStartup({
      startupFn: async () => {
        throw new Error('daemon bootstrap failed');
      },
      listenFn: async () => {
        listenCalled = true;
      }
    }),
    /daemon bootstrap failed/
  );

  assert.equal(listenCalled, false);
});
