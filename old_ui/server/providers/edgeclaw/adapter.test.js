import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeMessage } from './adapter.js';

test('normalizeMessage preserves background cron trigger meta prompts', () => {
  const messages = normalizeMessage(
    {
      uuid: 'cron-trigger',
      type: 'user',
      isMeta: true,
      timestamp: '2026-04-29T12:00:00.000Z',
      message: {
        role: 'user',
        content: '提醒用户：该站起来活动一下了！',
      },
    },
    'background-session',
    { sessionKind: 'background_task' }
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '提醒用户：该站起来活动一下了！');
});

test('normalizeMessage still hides non-background meta prompts', () => {
  const messages = normalizeMessage(
    {
      uuid: 'meta-main-chat',
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: 'internal setup prompt',
      },
    },
    'regular-session'
  );

  assert.deepEqual(messages, []);
});

test('normalizeMessage converts background api_error system events to errors', () => {
  const messages = normalizeMessage(
    {
      uuid: 'api-error',
      type: 'system',
      subtype: 'api_error',
      timestamp: '2026-04-29T12:00:01.000Z',
      cause: {
        code: 'ConnectionRefused',
        path: 'http://ccr.local/v1/messages?beta=true',
      },
      retryAttempt: 2,
      maxRetries: 10,
    },
    'background-session',
    { sessionKind: 'background_task' }
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'error');
  assert.match(messages[0].content, /ConnectionRefused/);
  assert.match(messages[0].content, /Retry 2\/10/);
});

test('normalizeMessage keeps synthetic assistant API errors as errors', () => {
  const messages = normalizeMessage(
    {
      uuid: 'synthetic-api-error',
      type: 'assistant',
      isApiErrorMessage: true,
      timestamp: '2026-04-29T12:00:02.000Z',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: 'API Error: Unable to connect to API (ConnectionRefused)',
          },
        ],
      },
    },
    'background-session',
    { sessionKind: 'background_task' }
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'error');
  assert.equal(messages[0].content, 'API Error: Unable to connect to API (ConnectionRefused)');
});
