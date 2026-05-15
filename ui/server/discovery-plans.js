/**
 * Thin adapter — delegates all discovery-plan business logic to
 * `src/always-on/web/DiscoveryPlanService.ts`.
 *
 * This file only wires the service's dependency injection and
 * re-exports the public API surface consumed by routes and slash
 * commands.
 */

import { isSessionActiveViaGateway as isClaudeSDKSessionActive, getPilotDeckGateway } from './pilotdeck-bridge.js';
import {
  extractProjectDirectory,
  getProjectCronJobsOverview,
  getSessions,
} from './projects.js';
import { appendAlwaysOnRunEvent } from './services/always-on-run-history.js';
import {
  appendAlwaysOnRunLog,
  appendAlwaysOnRunLogEvent,
  formatAlwaysOnPlanLogLine,
} from './services/always-on-run-logs.js';
import { resolvePilotHome, createProjectId } from './utils/pilotPaths.js';

import { DiscoveryPlanService } from '../../src/always-on/web/DiscoveryPlanService.js';
import { buildDiscoveryContext } from '../../src/always-on/web/DiscoveryPlanContext.js';
import {
  applyWorktreeToProject,
  disposeWorkspace as disposeWorkspaceImpl,
} from '../../src/always-on/workspace/WorkspaceApply.js';

// ---------------------------------------------------------------------------
// Wire dependencies for the service
// ---------------------------------------------------------------------------

function getService() {
  return new DiscoveryPlanService({
    pilotHome: resolvePilotHome(),
    createProjectId,
    paths: { extractProjectDirectory },
    sessions: { getSessions },
    activity: { isSessionActive: isClaudeSDKSessionActive },
    events: {
      appendRunEvent: appendAlwaysOnRunEvent,
      appendRunLog: appendAlwaysOnRunLog,
      appendRunLogEvent: appendAlwaysOnRunLogEvent,
      formatLogLine: formatAlwaysOnPlanLogLine,
    },
    workspace: {
      applyWorktreeChanges: applyWorktreeToProject,
      disposeWorkspace: disposeWorkspaceImpl,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getProjectDiscoveryContext(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  return buildDiscoveryContext({
    projectName,
    projectRoot,
    getProjectCronJobsOverview,
    getSessions,
    extractProjectDirectory,
  });
}

export async function getProjectDiscoveryPlansOverview(projectName) {
  return getService().getPlansOverview(projectName);
}

export async function queueDiscoveryPlanExecution(projectName, planId, options = {}) {
  return getService().queueExecution(projectName, planId, options);
}

export async function updateProjectDiscoveryPlanExecution(projectName, planId, updates = {}) {
  return getService().updateExecution(projectName, planId, updates);
}

export async function archiveProjectDiscoveryPlan(projectName, planId) {
  return getService().archive(projectName, planId);
}

export async function getProjectDiscoveryPlanReport(projectName, planId) {
  return getService().readReport(projectName, planId);
}

export async function applyProjectDiscoveryPlan(projectName, planId) {
  const result = await getService().queueApply(projectName, planId);

  const gw = await getPilotDeckGateway();
  if (gw.alwaysOnApply) {
    const applyResult = await gw.alwaysOnApply({
      projectKey: result.projectRoot,
      planId,
      projectName,
    });
    return {
      plan: result.plan,
      sessionKey: applyResult.sessionKey,
      executionToken: result.executionToken,
      error: applyResult.error,
    };
  }

  return result;
}
