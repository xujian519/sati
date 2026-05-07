import type { CanonicalMessage, CanonicalToolSchema } from "../../model/index.js";

export type AgentContextPrepareInput = {
  messages: CanonicalMessage[];
  tools: CanonicalToolSchema[];
  maxMessages?: number;
};

export type AgentPreparedContext = {
  messages: CanonicalMessage[];
  tools: CanonicalToolSchema[];
  boundaries: AgentContextBoundary[];
  diagnostics: AgentContextDiagnostic[];
};

export type AgentContextBoundary = {
  type: "compact";
  retainedMessages: number;
};

export type AgentContextDiagnostic = {
  code: "context_truncated" | "context_budget_not_enforced";
  message: string;
};

export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
};
