import type { PolitDeckHookEvent } from "../protocol/events.js";

export type PolitDeckHookExecutionEvent =
  | {
      type: "started";
      hookName: string;
      hookEvent: PolitDeckHookEvent;
    }
  | {
      type: "response";
      hookName: string;
      hookEvent: PolitDeckHookEvent;
      stdout: string;
      stderr: string;
      exitCode?: number;
      outcome: "success" | "blocking" | "non_blocking_error" | "cancelled" | "timeout";
    };

export type PolitDeckHookExecutionEventHandler = (event: PolitDeckHookExecutionEvent) => void;

export class HookExecutionEventBus {
  private handlers = new Set<PolitDeckHookExecutionEventHandler>();

  subscribe(handler: PolitDeckHookExecutionEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: PolitDeckHookExecutionEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
