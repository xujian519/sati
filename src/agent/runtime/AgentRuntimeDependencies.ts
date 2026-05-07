import type { CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type { PolitDeckToolAuditRecorder, PolitDeckToolScheduler, ToolRegistry } from "../../tool/index.js";
import type { AgentContextRuntime } from "../context/ContextRuntime.js";

export type AgentModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};

export type AgentRuntimeDependencies = {
  model: AgentModelRuntime;
  tools: {
    scheduler: PolitDeckToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PolitDeckToolAuditRecorder;
};
