import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeTurnkeySlashCommand,
  parseTurnkeySlashArgs,
} from './turnkey-slash.js';

test('parseTurnkeySlashArgs parses known subcommands', () => {
  assert.deepEqual(parseTurnkeySlashArgs(['start', 'fix', 'bug']), {
    action: 'forward',
    subcommand: 'start',
    args: ['fix', 'bug'],
  });
  assert.deepEqual(parseTurnkeySlashArgs(['review']), {
    action: 'forward',
    subcommand: 'review',
    args: [],
  });
});

test('parseTurnkeySlashArgs falls back to help for empty and unknown input', () => {
  assert.deepEqual(parseTurnkeySlashArgs([]), { action: 'help' });
  assert.deepEqual(parseTurnkeySlashArgs(['help']), { action: 'help' });
  assert.deepEqual(parseTurnkeySlashArgs(['invalid']), {
    action: 'help',
    error: 'Unknown /turnkey action: `invalid`',
  });
});

test('executeTurnkeySlashCommand forwards valid subcommands', async () => {
  const result = await executeTurnkeySlashCommand(['test', 'smoke']);
  assert.equal(result.type, 'custom');
  assert.equal(result.content, '/turnkey:test smoke');
  assert.equal(result.hasBashCommands, false);
  assert.equal(result.hasFileIncludes, false);
});

test('executeTurnkeySlashCommand returns help markdown for invalid input', async () => {
  const result = await executeTurnkeySlashCommand(['unknown']);
  assert.equal(result.type, 'builtin');
  assert.equal(result.action, 'help');
  assert.match(result.data.content, /Unknown \/turnkey action/);
  assert.match(result.data.content, /\/turnkey start/);
});
