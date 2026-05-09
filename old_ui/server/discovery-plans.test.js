import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveProjectDiscoveryPlan,
  getProjectDiscoveryPlansOverview,
  queueDiscoveryPlanExecution,
  readDiscoveryPlanStore,
  updateProjectDiscoveryPlanExecution,
} from './discovery-plans.js';
import {
  clearProjectDirectoryCache,
} from './projects.js';
import { getAlwaysOnRunHistory } from './services/always-on-run-history.js';
import { getAlwaysOnRunLog } from './services/always-on-run-logs.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs = [];

async function createTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempHome() {
  const homeDir = await createTempDir('discovery-plans-home-');
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  clearProjectDirectoryCache();
  return homeDir;
}

async function writeProjectConfig(homeDir, projectName, projectRoot) {
  const claudeDir = path.join(homeDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(path.join(claudeDir, 'projects', projectName), { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'project-config.json'),
    JSON.stringify({
      [projectName]: {
        manuallyAdded: true,
        originalPath: projectRoot,
      },
    }, null, 2),
    'utf8',
  );
}

async function writeDiscoveryPlan(projectRoot, plan) {
  const alwaysOnDir = path.join(projectRoot, '.claude', 'always-on');
  const plansDir = path.join(alwaysOnDir, 'plans');
  await fs.mkdir(plansDir, { recursive: true });

  await fs.writeFile(
    path.join(alwaysOnDir, 'discovery-plans.json'),
    JSON.stringify({
      version: 1,
      plans: [plan],
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(projectRoot, plan.planFilePath),
    `# Example plan\n\n## Context\nA\n\n## Signals Reviewed\nB\n\n## Proposed Work\nC\n\n## Execution Steps\nD\n\n## Verification\nE\n\n## Approval And Execution\nF\n`,
    'utf8',
  );
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
});

test('discovery plans can be listed, queued, updated, and archived', async () => {
  const homeDir = await createTempHome();
  const projectName = 'project-discovery-plans';
  const projectRoot = path.join(homeDir, 'workspace-discovery-plans');
  const createdAt = '2026-04-20T10:00:00.000Z';

  await fs.mkdir(projectRoot, { recursive: true });
  await writeProjectConfig(homeDir, projectName, projectRoot);
  await writeDiscoveryPlan(projectRoot, {
    id: 'plan-alpha',
    title: 'Investigate flaky tests',
    createdAt,
    updatedAt: createdAt,
    approvalMode: 'manual',
    status: 'ready',
    summary: 'Check the recent flaky test failures and stabilize the suite.',
    rationale: 'This keeps CI healthy and avoids regressions shipping unnoticed.',
    dedupeKey: 'flaky-tests',
    sourceDiscoverySessionId: 'discovery-session-1',
    contextRefs: {
      workingDirectory: ['git status showed test changes'],
      memory: [],
      existingPlans: [],
      cronJobs: [],
      recentChats: [],
    },
    planFilePath: '.claude/always-on/plans/plan-alpha.md',
    structureVersion: 1,
  });

  const overview = await getProjectDiscoveryPlansOverview(projectName);
  assert.equal(overview.plans.length, 1);
  assert.equal(overview.plans[0].id, 'plan-alpha');
  assert.equal(overview.plans[0].status, 'ready');
  assert.match(overview.plans[0].content, /## Proposed Work/);

  const execution = await queueDiscoveryPlanExecution(projectName, 'plan-alpha');
  assert.equal(execution.plan.status, 'queued');
  assert.equal(execution.sessionSummary, 'Always-On: Investigate flaky tests');
  assert.match(execution.command, /Do not enter Plan Mode/);
  assert.match(execution.command, /## Execution Steps/);
  assert.ok(execution.executionToken);

  let store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'queued');
  assert.equal(store.plans[0].executionStatus, 'queued');

  const runningPlan = await updateProjectDiscoveryPlanExecution(projectName, 'plan-alpha', {
    executionSessionId: 'session-123',
    status: 'running',
    executionToken: execution.executionToken,
  });
  assert.equal(runningPlan.executionSessionId, 'session-123');
  assert.equal(runningPlan.status, 'running');

  await updateProjectDiscoveryPlanExecution(projectName, 'plan-alpha', {
    executionSessionId: 'session-123',
    status: 'completed',
    latestSummary: 'Tests were stabilized and rerun successfully.',
    executionToken: execution.executionToken,
  });

  const history = await getAlwaysOnRunHistory(projectRoot);
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].runId, execution.executionToken);
  assert.equal(history.runs[0].status, 'completed');
  assert.equal(history.runs[0].sourceId, 'plan-alpha');

  const runLog = await getAlwaysOnRunLog(projectRoot, execution.executionToken);
  assert.match(runLog.content, /\[AlwaysOnPlanRun\]/);
  assert.match(runLog.content, /phase=queued/);
  assert.match(runLog.content, /phase=completed/);
  assert.match(runLog.content, /Tests were stabilized/);

  const archiveResult = await archiveProjectDiscoveryPlan(projectName, 'plan-alpha');
  assert.deepEqual(archiveResult, { archived: true });

  store = await readDiscoveryPlanStore(projectRoot);
  assert.equal(store.plans[0].status, 'superseded');
});
