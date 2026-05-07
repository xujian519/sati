import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type { PolitDeckToolAuditRecorder, PolitDeckToolScheduler, ToolRegistry } from "../../tool/index.js";

export type AgentModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

export type AgentRuntimeDependencies = {
  model: AgentModelRuntime;
  tools: {
    scheduler: PolitDeckToolScheduler;
    registry: ToolRegistry;
  };
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PolitDeckToolAuditRecorder;
};
