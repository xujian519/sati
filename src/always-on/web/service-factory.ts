/**
 * DiscoveryPlanService assembly factory.
 *
 * Moves the DI wiring that used to live in `ui/server/discovery-plans.js`
 * (`getService`) into the core so all hosts (Web UI, CLI, future SDK)
 * construct the service identically.
 *
 * Core-resolved dependencies:
 *   - pilotHome / project-id resolution (`src/pilot/paths.ts`)
 *   - workspace apply/dispose (`src/always-on/workspace/WorkspaceApply.ts`)
 *   - discovery state cleanup (`src/always-on/storage/DiscoveryStateStore.ts`)
 *
 * Host-specific I/O is injected via `io` (project path resolution, session
 * listing, session activity check, run-history/run-log sinks). The concrete
 * `DiscoveryPlanServiceDeps` shape stays internal; hosts only depend on the
 * minimal `DiscoveryPlanIo` contract.
 */
import { resolvePilotHome, resolveProjectStorageId } from "../../pilot/paths.js";
import { resolveAlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";
import { applyWorktreeToProject, disposeWorkspace } from "../workspace/WorkspaceApply.js";
import { DiscoveryPlanService } from "./DiscoveryPlanService.js";

/** Host-provided I/O adapters required by the discovery plan service. */
export type DiscoveryPlanIo = {
  extractProjectDirectory(projectName: string): Promise<string>;
  getSessions(
    projectName: string,
    limit: number,
    offset: number,
  ): Promise<{ sessions: Array<Record<string, unknown>> }>;
  isSessionActive(sessionId: string): boolean;
  appendRunEvent(projectRoot: string, event: Record<string, unknown>): Promise<unknown>;
  appendRunLog(projectRoot: string, runId: string, lines: string[]): Promise<void>;
  appendRunLogEvent(projectRoot: string, runId: string, event: Record<string, unknown>): Promise<void>;
  formatLogLine(entry: Record<string, unknown>): string;
};

export type CreateDiscoveryPlanServiceOptions = {
  /** Sati home directory. Defaults to the core `resolvePilotHome()` (~/.sati). */
  pilotHome?: string;
  /** Project-id encoder. Defaults to core `resolveProjectStorageId`. */
  resolveProjectId?: (projectRoot: string) => string;
  io: DiscoveryPlanIo;
};

export function createDiscoveryPlanService(options: CreateDiscoveryPlanServiceOptions): DiscoveryPlanService {
  const pilotHome = options.pilotHome ?? resolvePilotHome();
  const resolveProjectId =
    options.resolveProjectId ?? ((projectRoot: string) => resolveProjectStorageId(projectRoot, pilotHome));
  const io = options.io;

  return new DiscoveryPlanService({
    pilotHome,
    resolveProjectId,
    paths: { extractProjectDirectory: io.extractProjectDirectory },
    sessions: { getSessions: io.getSessions },
    // Read lazily so hosts can replace `io.isSessionActive` after the
    // service is built (e.g. wiring the gateway's live turn state once
    // the gateway exists).
    activity: { isSessionActive: sessionId => io.isSessionActive(sessionId) },
    events: {
      appendRunEvent: io.appendRunEvent,
      appendRunLog: io.appendRunLog,
      appendRunLogEvent: io.appendRunLogEvent,
      formatLogLine: io.formatLogLine,
    },
    workspace: {
      applyWorktreeChanges: applyWorktreeToProject,
      disposeWorkspace,
    },
    state: {
      clearActiveWorkCycleId: async projectRoot => {
        const paths = resolveAlwaysOnPaths({
          pilotHome,
          projectKey: projectRoot,
          projectId: resolveProjectId(projectRoot),
        });
        const store = new DiscoveryStateStore(paths);
        await store.clearActiveWorkCycleId(new Date());
      },
    },
  });
}
