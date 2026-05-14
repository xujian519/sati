/**
 * Thin adapter — delegates all discovery-plan business logic to
 * `src/always-on/web/DiscoveryPlanService.ts`.
 *
 * This file only wires the service's dependency injection and
 * re-exports the public API surface consumed by routes and slash
 * commands.
 */

import { isSessionActiveViaGateway as isClaudeSDKSessionActive } from './pilotdeck-bridge.js';
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
  });
}

// ---------------------------------------------------------------------------
// Public API — same signatures as the old module
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

export async function readDiscoveryPlanStore(projectRoot) {
  const service = getService();
  const pilotHome = resolvePilotHome();
  const projectId = createProjectId(projectRoot);
  // Use the internal store reader via a minimal shim — projectName
  // is not available here, but we can pass the root directly through
  // the path resolver.
  const shimService = new DiscoveryPlanService({
    pilotHome,
    createProjectId,
    paths: { extractProjectDirectory: async () => projectRoot },
    sessions: { getSessions: async () => ({ sessions: [] }) },
    activity: { isSessionActive: () => false },
    events: {
      appendRunEvent: appendAlwaysOnRunEvent,
      appendRunLog: appendAlwaysOnRunLog,
      appendRunLogEvent: appendAlwaysOnRunLogEvent,
      formatLogLine: formatAlwaysOnPlanLogLine,
    },
  });
  return shimService.readStore('_unused_');
}

export {
  readDiscoveryPlanStore as _readDiscoveryPlanStore,
};
