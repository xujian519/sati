import { randomUUID } from "node:crypto";
import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { AlwaysOnApplyInput, AlwaysOnApplyResult } from "../../gateway/protocol/types.js";
import { resolveAlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";

export type CreateApplyHandlerDeps = {
  gateway: Gateway;
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  alwaysOnConfig?: AlwaysOnConfig;
};

/**
 * Build a lightweight apply handler that does NOT depend on
 * `AlwaysOnManager` or `DiscoveryScheduler`. It reads the plan from
 * disk and delegates to `DiscoveryFire.runApplyPhase`, which only
 * requires `gateway`, `sessionOverrides`, and the plan record.
 *
 * Unused deps are stubbed out so the `DiscoveryFire` constructor is
 * satisfied — apply never touches stateStore / workspaceRegistry / etc.
 */
export function createApplyHandler(
  deps: CreateApplyHandlerDeps,
): (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult> {
  return async (input) => {
    const paths = resolveAlwaysOnPaths({
      pilotHome: deps.pilotHome,
      projectKey: input.projectKey,
    });

    const planStore = new DiscoveryPlanStore(paths);
    const plan = await planStore.getRecord(input.planId);
    if (!plan) {
      return {
        sessionKey: "",
        error: { code: "plan_not_found", message: `Plan ${input.planId} not found` },
      };
    }

    if (!plan.workspace?.cwd) {
      return {
        sessionKey: "",
        error: { code: "missing_workspace", message: "Plan has no associated workspace to apply" },
      };
    }

    const baseConfig = deps.alwaysOnConfig ?? defaultAlwaysOnConfig();
    const minimalDeps: DiscoveryFireDependencies = {
      config: baseConfig,
      paths,
      projectKey: input.projectKey,
      gateway: deps.gateway,
      runContexts: new AlwaysOnRunContextRegistry(),
      workspaceRegistry: new WorkspaceProviderRegistry(),
      sessionOverrides: deps.sessionOverrides,
      stateStore: new DiscoveryStateStore(paths),
      planStore,
      reportStore: new DiscoveryReportStore(paths),
      eventStore: new AlwaysOnEventStore(paths),
      uuid: () => randomUUID(),
      now: () => new Date(),
      onTurnEvent: deps.onTurnEvent,
    };

    const fire = new DiscoveryFire(minimalDeps);
    const runId = randomUUID();
    const result = await fire.runApplyPhase({
      runId,
      plan: {
        id: plan.id,
        title: plan.title,
        workspace: plan.workspace,
      },
      projectName: input.projectName,
      projectRoot: input.projectKey,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  };
}
