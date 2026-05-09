import type { DiscoveryPlanRecord, WorkspaceHandle } from "../protocol/types.js";
import type { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import type { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";

export type DiscoveryRunContext = {
  kind: "discovery";
  sessionKey: string;
  runId: string;
  projectKey: string;
  paths: AlwaysOnPaths;
  startedAt: Date;
  planStore: DiscoveryPlanStore;
  /** Set after the plan tool succeeds. */
  plan?: { record: DiscoveryPlanRecord; markdown: string };
  /** Number of plan-tool calls in this fire (success and failure). */
  planCallCount: number;
};

export type ExecutionRunContext = {
  kind: "execution";
  sessionKey: string;
  runId: string;
  projectKey: string;
  paths: AlwaysOnPaths;
  workspace: WorkspaceHandle;
  plan: DiscoveryPlanRecord;
  reportStore: DiscoveryReportStore;
  reportCallCount: number;
  /** Set after the first successful report tool call. */
  report?: { markdown: string; filePath: string; finishedAt: Date };
};

export type AlwaysOnRunContext = DiscoveryRunContext | ExecutionRunContext;

/**
 * Single-process, mutable registry that maps `sessionKey` -> in-flight
 * Always-On run context. Always-On tools query this registry to locate the
 * current run; the runtime registers contexts before submitting a turn and
 * unregisters once the turn settles.
 */
export class AlwaysOnRunContextRegistry {
  private readonly contexts = new Map<string, AlwaysOnRunContext>();

  register(ctx: AlwaysOnRunContext): void {
    if (this.contexts.has(ctx.sessionKey)) {
      throw new Error(`AlwaysOn run context already exists for sessionKey: ${ctx.sessionKey}`);
    }
    this.contexts.set(ctx.sessionKey, ctx);
  }

  unregister(sessionKey: string): void {
    this.contexts.delete(sessionKey);
  }

  get(sessionKey: string): AlwaysOnRunContext | undefined {
    return this.contexts.get(sessionKey);
  }

  getDiscovery(sessionKey: string): DiscoveryRunContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx && ctx.kind === "discovery" ? ctx : undefined;
  }

  getExecution(sessionKey: string): ExecutionRunContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx && ctx.kind === "execution" ? ctx : undefined;
  }

  list(): AlwaysOnRunContext[] {
    return Array.from(this.contexts.values());
  }
}
