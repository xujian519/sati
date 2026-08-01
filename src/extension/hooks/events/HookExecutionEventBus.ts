import type { SatiHookEvent } from "../protocol/events.js";

export type SatiHookExecutionEvent =
  | {
      type: "started";
      hookName: string;
      hookEvent: SatiHookEvent;
    }
  | {
      type: "response";
      hookName: string;
      hookEvent: SatiHookEvent;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
    };

export type SatiHookExecutionEventHandler = (event: SatiHookExecutionEvent) => void;

export class HookExecutionEventBus {
  private handlers = new Set<SatiHookExecutionEventHandler>();

  subscribe(handler: SatiHookExecutionEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: SatiHookExecutionEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
