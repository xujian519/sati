import type { CanonicalThinkingConfig, CanonicalToolChoice } from "../../model/index.js";
import type { PermissionContext, PermissionMode } from "../../permission/index.js";

export type AgentRuntimeConfig = {
  provider: string;
  model: string;
  cwd: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: CanonicalThinkingConfig;
  toolChoice?: CanonicalToolChoice;
  fallbackProvider?: string;
  fallbackModel?: string;
  maxContextMessages?: number;
  stopOnStructuredOutput?: boolean;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  metadata?: Record<string, unknown>;
  /**
   * Subagent fork depth — incremented on each level of `agent` tool fork.
   * Top-level agent runs at depth 0; `agent` tool refuses to spawn another
   * subagent once `subagentDepth >= maxSubagentDepth`. Default 0.
   */
  subagentDepth?: number;
  /**
   * Cap on `subagentDepth`. Defaults to 1 (one level of forking allowed,
   * but no nested forks). Increase only when intentional.
   */
  maxSubagentDepth?: number;
};
