export type SatiHookPermissionBehavior = "allow" | "deny" | "ask" | "passthrough";

export type SatiPermissionRequestResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type SatiHookEffect =
  | { type: "additional_context"; content: string; source: string }
  | { type: "system_message"; content: string }
  | { type: "block"; reason: string; stopReason?: string }
  | { type: "permission_decision"; behavior: SatiHookPermissionBehavior; reason?: string }
  | { type: "updated_tool_input"; input: Record<string, unknown> }
  | { type: "updated_mcp_tool_output"; output: unknown }
  | { type: "permission_request_result"; result: SatiPermissionRequestResult }
  | { type: "initial_user_message"; message: string }
  | { type: "watch_paths"; paths: string[] }
  | { type: "worktree_path"; path: string }
  | { type: "retry_permission_denied" };

export type SatiLifecycleError = {
  code: "hook_blocking_error" | "hook_non_blocking_error" | "hook_execution_failed" | "hook_cancelled";
  message: string;
  hookName?: string;
  exitCode?: number;
};
