export class SatiLifecycleRuntimeError extends Error {
  readonly name = "SatiLifecycleRuntimeError";

  constructor(
    readonly code: "hook_blocked" | "hook_failed",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
