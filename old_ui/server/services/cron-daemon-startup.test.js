import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCronDaemonEnv,
  buildCronDaemonSpawnCommand,
  ensureCronDaemonForUiStartup,
  startCronDaemonDetached
} from './cron-daemon-startup.js';

function createUnavailableError(code) {
  const error = new Error(`${code} unavailable`);
  error.code = code;
  return error;
}

let tempConfigDir;
let priorConfigDir;
let priorAnthropicBaseUrl;
let priorCcrDaemonFetchInterceptor;

beforeEach(async () => {
  priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  priorAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  priorCcrDaemonFetchInterceptor = process.env.CCR_DAEMON_FETCH_INTERCEPTOR;
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ui-cron-daemon-startup-'));
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CCR_DAEMON_FETCH_INTERCEPTOR;
});

afterEach(async () => {
  if (priorConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  }
  if (priorAnthropicBaseUrl === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = priorAnthropicBaseUrl;
  }
  if (priorCcrDaemonFetchInterceptor === undefined) {
    delete process.env.CCR_DAEMON_FETCH_INTERCEPTOR;
  } else {
    process.env.CCR_DAEMON_FETCH_INTERCEPTOR = priorCcrDaemonFetchInterceptor;
  }
  await rm(tempConfigDir, { recursive: true, force: true });
});

test('buildCronDaemonSpawnCommand prefers the local Claude Code tree and falls back to the CLI path', () => {
  const localCommand = buildCronDaemonSpawnCommand({
    resolveClaudeCodeMainRootFn: () => '/tmp/claude-code-main'
  });

  assert.equal(localCommand.command, 'bun');
  assert.deepEqual(localCommand.args.slice(0, 3), [
    '--preload',
    '/tmp/claude-code-main/preload.ts',
    '-e'
  ]);
  assert.match(localCommand.args[3], /daemonMain/);
  assert.match(localCommand.args[3], /daemonMain\(\['serve'\]\)/);
  assert.doesNotMatch(localCommand.args.join(' '), /\brun\b/);
  assert.doesNotMatch(localCommand.args.join(' '), /cli\.tsx/);

  const fallbackCommand = buildCronDaemonSpawnCommand({
    resolveClaudeCodeMainRootFn: () => null,
    cliPath: '/opt/bin/claude'
  });

  assert.deepEqual(fallbackCommand, {
    command: '/opt/bin/claude',
    args: ['daemon', 'serve']
  });
});

test('buildCronDaemonEnv opts daemon preload into CCR interceptor for sentinel base URL', () => {
  assert.deepEqual(buildCronDaemonEnv({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080'
  }), {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080'
  });

  assert.deepEqual(buildCronDaemonEnv({
    ANTHROPIC_BASE_URL: 'http://ccr.local'
  }), {
    ANTHROPIC_BASE_URL: 'http://ccr.local',
    CCR_DAEMON_FETCH_INTERCEPTOR: '1'
  });
});

test('startCronDaemonDetached passes CCR interceptor opt-in in sentinel mode', () => {
  const spawnCalls = [];
  process.env.ANTHROPIC_BASE_URL = 'http://ccr.local';

  startCronDaemonDetached({
    spawnFn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { unref() {} };
    },
    buildCronDaemonSpawnCommandFn: () => ({
      command: 'bun',
      args: ['--preload', '/tmp/preload.ts', '-e', 'noop']
    }),
    openLogFdFn: () => ({ fd: null, logPath: '/tmp/cron-daemon.log' })
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.env.ANTHROPIC_BASE_URL, 'http://ccr.local');
  assert.equal(spawnCalls[0].options.env.CCR_DAEMON_FETCH_INTERCEPTOR, '1');
});

test('ensureCronDaemonForUiStartup reuses a healthy daemon without spawning a new process', async () => {
  const requests = [];
  let spawnCalled = false;

  const response = await ensureCronDaemonForUiStartup({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      return { ok: true, data: { type: 'pong', runtimes: [] } };
    },
    spawnFn: () => {
      spawnCalled = true;
      return { unref() {} };
    }
  });

  assert.equal(response.data.type, 'pong');
  assert.deepEqual(requests, [{ type: 'ping' }]);
  assert.equal(spawnCalled, false);
});

test('ensureCronDaemonForUiStartup starts the daemon when the socket is unavailable', async () => {
  const requests = [];
  const spawnCalls = [];
  let requestCount = 0;

  const response = await ensureCronDaemonForUiStartup({
    sendCronDaemonRequestFn: async (request) => {
      requests.push(request);
      requestCount += 1;
      if (requestCount <= 2) {
        throw createUnavailableError('ENOENT');
      }
      return { ok: true, data: { type: 'pong', runtimes: [] } };
    },
    spawnFn: (command, args, options) => {
      const call = { command, args, options, unrefCalled: false };
      spawnCalls.push(call);
      return {
        unref() {
          call.unrefCalled = true;
        }
      };
    },
    buildCronDaemonSpawnCommandFn: () => ({
      command: 'bun',
      args: [
        '--preload',
        '/tmp/claude-code-main/preload.ts',
        '-e',
        `const { daemonMain } = await import(${JSON.stringify('/tmp/claude-code-main/src/daemon/main.ts')}); await daemonMain(['serve'])`
      ]
    }),
    // Simulate "log file unavailable" so we exercise the fd=null branch and
    // keep the historical stdio:'ignore' contract (used by tests that don't
    // care about logging).
    openLogFdFn: () => ({ fd: null, logPath: '/tmp/cron-daemon.log' }),
    sleepFn: async () => {}
  });

  assert.equal(response.data.type, 'pong');
  assert.deepEqual(requests, [{ type: 'ping' }, { type: 'ping' }, { type: 'ping' }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'bun');
  assert.deepEqual(spawnCalls[0].args.slice(0, 3), [
    '--preload',
    '/tmp/claude-code-main/preload.ts',
    '-e'
  ]);
  assert.match(spawnCalls[0].args[3], /daemonMain\(\['serve'\]\)/);
  assert.equal(spawnCalls[0].options.cwd, process.cwd());
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.stdio, 'ignore');
  assert.equal(spawnCalls[0].options.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(spawnCalls[0].options.env.CCR_DAEMON_FETCH_INTERCEPTOR, undefined);
  assert.equal(spawnCalls[0].unrefCalled, true);
});

test('ensureCronDaemonForUiStartup pipes daemon stdio to the resolved log fd when available', async () => {
  const spawnCalls = [];
  let requestCount = 0;

  await ensureCronDaemonForUiStartup({
    sendCronDaemonRequestFn: async () => {
      requestCount += 1;
      // First two pings (probe + post-lock probe) are unavailable so we go
      // through the spawn branch; subsequent pings succeed.
      if (requestCount <= 2) throw createUnavailableError('ENOENT');
      return { ok: true, data: { type: 'pong', runtimes: [] } };
    },
    spawnFn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { unref() {} };
    },
    buildCronDaemonSpawnCommandFn: () => ({
      command: 'bun',
      args: ['--preload', '/tmp/preload.ts', '-e', 'noop']
    }),
    // Pretend openSync returned fd=42 — startCronDaemonDetached should hand it
    // to spawn as both stdout and stderr (stdin remains 'ignore').
    openLogFdFn: () => ({ fd: 42, logPath: '/tmp/cron-daemon.log' }),
    sleepFn: async () => {}
  });

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].options.stdio, ['ignore', 42, 42]);
  assert.equal(spawnCalls[0].options.detached, true);
});

test('ensureCronDaemonForUiStartup fails fast when the daemon never becomes healthy', async () => {
  let requestCount = 0;
  let sleepCount = 0;

  await assert.rejects(
    () => ensureCronDaemonForUiStartup({
      sendCronDaemonRequestFn: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          throw createUnavailableError('ENOENT');
        }
        throw new Error('Timed out waiting for Cron daemon response');
      },
      spawnFn: () => ({ unref() {} }),
      buildCronDaemonSpawnCommandFn: () => ({
        command: 'claude',
        args: ['daemon', 'serve']
      }),
      openLogFdFn: () => ({ fd: null, logPath: '/tmp/cron-daemon.log' }),
      sleepFn: async () => {
        sleepCount += 1;
      },
      retryAttempts: 3,
      retryDelayMs: 1
    }),
    /Timed out waiting for Cron daemon response/
  );

  assert.equal(requestCount, 5);
  assert.equal(sleepCount, 2);
});
