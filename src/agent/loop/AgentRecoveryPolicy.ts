import type { CanonicalModelError } from "../../model/index.js";
import { agentError, type AgentError } from "../protocol/errors.js";
import type { AgentStopReason } from "../protocol/result.js";

export type AgentRecoveryDecision =
  | { type: "fail"; stopReason: AgentStopReason; error: AgentError }
  | { type: "retry"; reason: "fallback_model"; provider: string; model: string };

export type AgentRecoveryPolicyOptions = {
  fallbackProvider?: string;
  fallbackModel?: string;
};

export class AgentRecoveryPolicy {
  private fallbackAttempted = false;

  constructor(private readonly options: AgentRecoveryPolicyOptions = {}) {}

  decideForModelError(error: CanonicalModelError): AgentRecoveryDecision {
    if (isPromptTooLong(error)) {
      return {
        type: "fail",
        stopReason: "prompt_too_long",
        error: agentError("agent_prompt_too_long", error.message, error),
      };
    }

    if (!this.fallbackAttempted && this.options.fallbackModel && error.retryable) {
      this.fallbackAttempted = true;
      return {
        type: "retry",
        reason: "fallback_model",
        provider: this.options.fallbackProvider ?? error.provider,
        model: this.options.fallbackModel,
      };
    }

    return {
      type: "fail",
      stopReason: "model_error",
      error: agentError("agent_model_error", error.message, error),
    };
  }
}

function isPromptTooLong(error: CanonicalModelError): boolean {
  const value = `${error.code} ${error.message}`.toLowerCase();
  return value.includes("prompt") && (value.includes("long") || value.includes("large"));
}
