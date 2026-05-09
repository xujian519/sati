import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type { PolitDeckToolAuditRecorder, PolitDeckToolScheduler, ToolRegistry } from "../../tool/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { RouterRuntime } from "../../router/index.js";

/**
 * Narrow view of the router that the agent loop actually consumes. Tests can
 * inject anything that satisfies this contract; production wiring uses
 * `createRouterRuntime`.
 */
export type AgentRouterRuntime = Pick<RouterRuntime, "stream"> & {
  observeUsage?: RouterRuntime["observeUsage"];
};

export type AgentRuntimeDependencies = {
  router: AgentRouterRuntime;
  tools: {
    scheduler: PolitDeckToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PolitDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
};

export type AgentLegacyModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};
