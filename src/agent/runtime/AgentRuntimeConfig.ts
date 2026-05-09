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
  maxContextMessages?: number;
  stopOnStructuredOutput?: boolean;
  permissionMode: PermissionMode;
  permissionContext: PermissionContext;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  metadata?: Record<string, unknown>;
  /** Marks the agent as a subagent. RouterRuntime uses this for sticky/scenario decisions. */
  isSubagent?: boolean;
};
