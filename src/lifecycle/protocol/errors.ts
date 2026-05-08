export class PolitDeckLifecycleRuntimeError extends Error {
  readonly name = "PolitDeckLifecycleRuntimeError";

  constructor(
    readonly code: "hook_blocked" | "hook_failed",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
