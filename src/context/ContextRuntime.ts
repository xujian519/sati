import type { CanonicalMessage, CanonicalModelError, CanonicalToolSchema } from "../model/index.js";
import type { ContextRecoveryDecision } from "./protocol/types.js";

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

/**
 * Optional reactive-recovery input the loop hands to context. When the
 * underlying context runtime returns a `truncate_head_and_retry` decision the
 * loop slices `messages` and retries the model call once per turn.
 */
export type AgentContextRecoveryInput = {
  sessionId: string;
  turnId: string;
  error: CanonicalModelError;
  messages: CanonicalMessage[];
  hasAttemptedCompact: boolean;
};

export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
  /**
   * Optional. Real implementations (e.g. `DefaultContextRuntime`) provide
   * this; minimal runtimes (`NullContextRuntime`) leave it undefined and the
   * loop falls back to `AgentRecoveryPolicy` directly.
   */
  recoverFromModelError?(input: AgentContextRecoveryInput): Promise<ContextRecoveryDecision>;
};
