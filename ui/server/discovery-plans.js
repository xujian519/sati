/**
 * Thin gateway proxy — all discovery-plan business logic now lives on the
 * gateway side (`InProcessGateway` + `DiscoveryPlanService` wired in
 * `src/cli/sati.ts`). This file resolves display names to project roots and
 * forwards to the `always_on_*` protocol methods exposed by the gateway.
 *
 * No direct `src/` imports remain — the gateway protocol is the only
 * boundary crossing (via `sati-bridge.js`).
 */

import { getSatiGateway } from "./sati-bridge.js";
import { extractProjectDirectory } from "./projects.js";

function toError(result) {
  if (result && result.error) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    return error;
  }
  return null;
}

async function getGateway() {
  return getSatiGateway();
}

export async function getProjectDiscoveryPlansOverview(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnListPlans({ projectKey: projectRoot });
  const error = toError(result);
  if (error) throw error;
  return { plans: result.plans };
}

export async function rerunDiscoveryPlan(projectName, planId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnRerunPlan({
    projectKey: projectRoot,
    planId,
    projectName,
  });
  const error = toError(result);
  if (error) throw error;
  return { runId: result.runId };
}

export async function getProjectDiscoveryPlanReport(projectName, planId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnReadReport({ projectKey: projectRoot, planId });
  const error = toError(result);
  if (error) throw error;
  return { content: result.content };
}

export async function getProjectWorkCycles(projectName) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnListCycles({ projectKey: projectRoot });
  const error = toError(result);
  if (error) throw error;
  return { cycles: result.cycles };
}

export async function archiveWorkCycle(projectName, cycleId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnArchiveCycle({ projectKey: projectRoot, cycleId });
  const error = toError(result);
  if (error) throw error;
  return { archived: result.archived };
}

export async function applyWorkCycle(projectName, cycleId) {
  const projectRoot = await extractProjectDirectory(projectName);
  const gw = await getGateway();
  const result = await gw.alwaysOnApplyCycle({ projectKey: projectRoot, workCycleId: cycleId });
  const error = toError(result);
  if (error) throw error;
  return { cycle: result.cycle, sessionKey: result.sessionKey };
}
