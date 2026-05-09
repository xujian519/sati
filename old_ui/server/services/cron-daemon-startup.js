import path from 'path';
import { promises as fs, openSync } from 'fs';
import { mkdirSync } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { resolveClaudeCodeMainRoot } from '../claude-code-main-path.js';
import { sendCronDaemonRequest } from './cron-daemon-owner.js';

const DEFAULT_RETRY_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 250;
const START_LOCK_STALE_MS = 30000;
const CCR_SENTINEL = 'http://ccr.local';
const CCR_DAEMON_FETCH_INTERCEPTOR = 'CCR_DAEMON_FETCH_INTERCEPTOR';

function getClaudeConfigHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getCronDaemonStartLockPath() {
  return path.join(getClaudeConfigHomeDir(), 'cron-daemon', 'start.lock');
}

/**
 * Resolve a log file path for the detached cron daemon.
 *
 * Prior to this, the daemon spawned with `stdio: 'ignore'` so all of its
 * lifecycle output, errors, and discovery-scheduler trace was silently
 * discarded — making post-mortem debugging on the EdgeClaw Desktop install
 * basically impossible (`~/.edgeclaw/desktop.server.log` only captured the
 * UI server's own output, not its detached children).
 *
 * We honour an explicit override via `EDGECLAW_CRON_DAEMON_LOG`; otherwise we
 * default to `~/.edgeclaw/cron-daemon.log` (parallel to `desktop.server.log`).
 * The directory is created on demand so this works pre-onboarding too.
 */
function resolveCronDaemonLogPath() {
  const override = process.env.EDGECLAW_CRON_DAEMON_LOG?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.edgeclaw', 'cron-daemon.log');
}

function openCronDaemonLogFd() {
  const logPath = resolveCronDaemonLogPath();
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    return { fd, logPath };
  } catch (err) {
    // Fall back to ignore — better to lose stdout than to fail to spawn.
    console.warn(`[WARN] Cron daemon log unavailable (${logPath}): ${err?.message ?? err}`);
    return { fd: null, logPath };
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isCronDaemonUnavailableError(error) {
  return Boolean(
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
  );
}

export function buildCronDaemonEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  if (env.ANTHROPIC_BASE_URL === CCR_SENTINEL) {
    env[CCR_DAEMON_FETCH_INTERCEPTOR] = '1';
  }
  return env;
}

export function buildCronDaemonSpawnCommand({
  resolveClaudeCodeMainRootFn = resolveClaudeCodeMainRoot,
  cliPath = process.env.CLAUDE_CLI_PATH
} = {}) {
  const localClaudeCodeMainRoot = resolveClaudeCodeMainRootFn();
  if (localClaudeCodeMainRoot) {
    const preloadPath = path.join(localClaudeCodeMainRoot, 'preload.ts');
    const daemonMainPath = path.join(localClaudeCodeMainRoot, 'src', 'daemon', 'main.ts');
    return {
      command: 'bun',
      args: [
        '--preload',
        preloadPath,
        '-e',
        `const { daemonMain } = await import(${JSON.stringify(daemonMainPath)}); await daemonMain(['serve'])`
      ]
    };
  }

  return {
    command: typeof cliPath === 'string' && cliPath.trim().length > 0 ? cliPath.trim() : 'claude',
    args: ['daemon', 'serve']
  };
}

async function acquireStartLock() {
  const lockPath = getCronDaemonStartLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
    return async () => {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const ageMs = await fs.stat(lockPath)
    .then((stats) => Date.now() - stats.mtimeMs)
    .catch(() => 0);
  if (ageMs > START_LOCK_STALE_MS) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return await acquireStartLock();
  }
  return null;
}

export async function pingCronDaemon({
  sendCronDaemonRequestFn = sendCronDaemonRequest
} = {}) {
  const response = await sendCronDaemonRequestFn({ type: 'ping' });
  if (!response?.ok || response.data?.type !== 'pong') {
    throw new Error('Unexpected Cron daemon ping response');
  }
  return response;
}

export function startCronDaemonDetached({
  spawnFn = spawn,
  buildCronDaemonSpawnCommandFn = buildCronDaemonSpawnCommand,
  openLogFdFn = openCronDaemonLogFd
} = {}) {
  const { command, args } = buildCronDaemonSpawnCommandFn();
  const { fd, logPath } = openLogFdFn();
  // Detach so multiple ui servers (e.g. dev + EdgeClaw Desktop side-by-side)
  // can share state through ~/.claude/cron-daemon.sock, but pipe stdout/stderr
  // into a real log file instead of /dev/null so the daemon is debuggable
  // post-mortem. Stdin stays 'ignore' (the daemon never reads input).
  const stdio = fd === null ? 'ignore' : ['ignore', fd, fd];
  const child = spawnFn(command, args, {
    cwd: process.cwd(),
    env: buildCronDaemonEnv(),
    detached: true,
    stdio
  });
  if (typeof child?.unref === 'function') {
    child.unref();
  }
  if (fd !== null) {
    console.log(`[INFO] Cron daemon spawned, output → ${logPath}`);
  }
  return child;
}

export async function ensureCronDaemonForUiStartup({
  sendCronDaemonRequestFn = sendCronDaemonRequest,
  spawnFn = spawn,
  buildCronDaemonSpawnCommandFn = buildCronDaemonSpawnCommand,
  openLogFdFn = openCronDaemonLogFd,
  sleepFn = sleep,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
} = {}) {
  try {
    return await pingCronDaemon({ sendCronDaemonRequestFn });
  } catch (error) {
    if (!isCronDaemonUnavailableError(error)) {
      throw error;
    }
  }

  const releaseStartLock = await acquireStartLock();
  if (releaseStartLock) {
    try {
      try {
        return await pingCronDaemon({ sendCronDaemonRequestFn });
      } catch {
        // We own startup now; any unhealthy ping means this process should spawn.
      }

      startCronDaemonDetached({
        spawnFn,
        buildCronDaemonSpawnCommandFn,
        openLogFdFn
      });

      let lastError = null;
      for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
        try {
          return await pingCronDaemon({ sendCronDaemonRequestFn });
        } catch (error) {
          lastError = error;
          if (attempt < retryAttempts - 1) {
            await sleepFn(retryDelayMs);
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Cron daemon failed to start');
    } finally {
      await releaseStartLock();
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    try {
      return await pingCronDaemon({ sendCronDaemonRequestFn });
    } catch (error) {
      lastError = error;
      if (attempt < retryAttempts - 1) {
        await sleepFn(retryDelayMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Cron daemon failed to start');
}
