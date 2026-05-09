import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  clearProjectDirectoryCache
} from '../projects.js';
import {
  handleDeleteProjectCronJob,
  handleRunProjectCronJobNow
} from './projects.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempHome() {
  const homeDir = await createTempDir('projects-cron-actions-home-');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  clearProjectDirectoryCache();
  return homeDir;
}

async function writeProjectConfig(homeDir, projectName, projectRoot) {
  const claudeDir = path.join(homeDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        manuallyAdded: true,
        originalPath: projectRoot
      }
    }, null, 2),
    'utf8'
  );
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function withCronDaemonServer(configDir, responder, callback) {
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const socketPath = path.join(configDir, 'cron-daemon.sock');
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const request = JSON.parse(buffer.slice(0, newlineIndex));
      requests.push(request);
      socket.end(`${JSON.stringify(responder(request))}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    await callback(requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

afterEach(async () => {
  clearProjectDirectoryCache();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
});

test('handleDeleteProjectCronJob proxies deletion to the cron daemon', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-actions-config-');
  const projectName = 'project-delete-cron';
  const projectRoot = path.join(homeDir, 'workspace-delete-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: { type: 'delete_task', deleted: true }
  }), async (requests) => {
    const res = createMockResponse();
    await handleDeleteProjectCronJob({
      params: {
        projectName,
        taskId: 'cron-1234'
      }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { deleted: true });
    assert.deepEqual(requests, [{
      type: 'delete_task',
      projectRoot,
      taskId: 'cron-1234'
    }]);
  });
});

test('handleDeleteProjectCronJob returns 404 when the task is missing', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-actions-config-');
  const projectName = 'project-delete-missing-cron';
  const projectRoot = path.join(homeDir, 'workspace-delete-missing-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: { type: 'delete_task', deleted: false }
  }), async () => {
    const res = createMockResponse();
    await handleDeleteProjectCronJob({
      params: {
        projectName,
        taskId: 'cron-missing'
      }
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Scheduled task not found' });
  });
});

test('handleRunProjectCronJobNow returns started when daemon launches the task', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-actions-config-');
  const projectName = 'project-run-now-cron';
  const projectRoot = path.join(homeDir, 'workspace-run-now-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: { type: 'run_task_now', started: true }
  }), async (requests) => {
    const res = createMockResponse();
    await handleRunProjectCronJobNow({
      params: {
        projectName,
        taskId: 'cron-run-now'
      }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { started: true });
    assert.deepEqual(requests, [{
      type: 'run_task_now',
      projectRoot,
      taskId: 'cron-run-now'
    }]);
  });
});

test('handleRunProjectCronJobNow surfaces already-running jobs without failing', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-actions-config-');
  const projectName = 'project-run-now-running-cron';
  const projectRoot = path.join(homeDir, 'workspace-run-now-running-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: { type: 'run_task_now', started: false, reason: 'already_running' }
  }), async () => {
    const res = createMockResponse();
    await handleRunProjectCronJobNow({
      params: {
        projectName,
        taskId: 'cron-running'
      }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      started: false,
      reason: 'already_running'
    });
  });
});

test('handleRunProjectCronJobNow returns 404 when daemon cannot find the task', async () => {
  const homeDir = await createTempHome();
  const configDir = await createTempDir('projects-cron-actions-config-');
  const projectName = 'project-run-now-missing-cron';
  const projectRoot = path.join(homeDir, 'workspace-run-now-missing-cron');
  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);

  await withCronDaemonServer(configDir, () => ({
    ok: true,
    data: { type: 'run_task_now', started: false, reason: 'not_found' }
  }), async () => {
    const res = createMockResponse();
    await handleRunProjectCronJobNow({
      params: {
        projectName,
        taskId: 'cron-missing'
      }
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Scheduled task not found' });
  });
});
