export type SatiToolErrorCode =
  | "tool_not_found"
  | "invalid_tool_input"
  | "permission_denied"
  | "permission_cancelled"
  | "permission_required"
  | "tool_execution_failed"
  | "tool_aborted"
  | "tool_timeout"
  | "tool_output_schema_mismatch"
  | "result_too_large"
  | "path_not_allowed"
  | "file_not_found"
  | "file_not_observed"
  | "file_stale_version"
  | "file_conflict"
  | "unsupported_tool"
  | "setup_required"
  | "plan_mode_violation"
  | "ask_mode_violation"
  | "team_actor_unknown"
  | "team_already_archived"
  | "team_bad_transition"
  | "team_member_retired"
  | "team_not_assignee"
  | "team_not_captain"
  | "team_not_found"
  | "team_not_member"
  | "team_stale_attempt"
  | "team_task_not_found"
  | "team_task_terminal"
  | "team_unknown_role";

export type SatiToolError = {
  code: SatiToolErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};

export class SatiToolRuntimeError extends Error {
  readonly code: SatiToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SatiToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SatiToolRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function toolError(code: SatiToolErrorCode, message: string, details?: Record<string, unknown>): SatiToolError {
  return { code, message, details };
}

export function normalizeToolError(error: unknown): SatiToolError {
  if (error instanceof SatiToolRuntimeError) {
    return toolError(error.code, error.message, error.details);
  }

  if (error instanceof Error) {
    return {
      code: "tool_execution_failed",
      message: error.message,
      cause: error,
    };
  }

  return {
    code: "tool_execution_failed",
    message: "Tool execution failed with a non-Error value.",
    cause: error,
  };
}
