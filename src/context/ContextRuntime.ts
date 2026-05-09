import type {
  ContextBoundary,
  ContextDiagnostic,
  ContextPrepareInput,
  ContextRecoveryDecision,
  ContextRecoveryInput,
  ModelContext,
} from "./protocol/types.js";

export type AgentContextPrepareInput = ContextPrepareInput;
export type AgentPreparedContext = ModelContext;
export type AgentContextBoundary = ContextBoundary;
export type AgentContextDiagnostic = ContextDiagnostic;

/**
 * Optional reactive-recovery input the loop hands to context. When the
 * underlying context runtime returns a `truncate_head_and_retry` decision the
 * loop slices `messages` and retries the model call once per turn.
 */
export type AgentContextRecoveryInput = ContextRecoveryInput;

export type AgentContextRuntime = {
  prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
  /**
   * Optional. Real implementations (e.g. `DefaultContextRuntime`) provide
   * this; minimal runtimes (`NullContextRuntime`) leave it undefined and the
   * loop falls back to `AgentRecoveryPolicy` directly.
   */
  recoverFromModelError?(input: AgentContextRecoveryInput): Promise<ContextRecoveryDecision>;
};
