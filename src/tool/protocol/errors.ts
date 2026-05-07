export type PolitDeckToolErrorCode =
  | "tool_not_found"
  | "invalid_tool_input"
  | "permission_denied"
  | "permission_cancelled"
  | "permission_required"
  | "tool_execution_failed"
  | "tool_aborted"
  | "tool_timeout"
  | "result_too_large"
  | "path_not_allowed"
  | "file_not_found"
  | "file_conflict"
  | "unsupported_tool";

export type PolitDeckToolError = {
  code: PolitDeckToolErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};

export class PolitDeckToolRuntimeError extends Error {
  readonly code: PolitDeckToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PolitDeckToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PolitDeckToolRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function toolError(
  code: PolitDeckToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PolitDeckToolError {
  return { code, message, details };
}

export function normalizeToolError(error: unknown): PolitDeckToolError {
  if (error instanceof PolitDeckToolRuntimeError) {
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
