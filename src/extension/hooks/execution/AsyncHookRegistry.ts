import type { PolitDeckHookEvent } from "../protocol/events.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { PolitDeckHookOutput } from "../protocol/output.js";

export type PendingAsyncHook = {
  id: string;
  startedAt: Date;
  hookName: string;
  hookEvent: PolitDeckHookEvent;
  stdout: string;
  stderr: string;
  responseDelivered: boolean;
  asyncRewake?: boolean;
};

export type AsyncHookResponse = {
  id: string;
  hookName: string;
  hookEvent: PolitDeckHookEvent;
  stdout: string;
  stderr: string;
  output: PolitDeckHookOutput;
  rewake: boolean;
};

export class AsyncHookRegistry {
  private readonly hooks = new Map<string, PendingAsyncHook>();

  register(hook: PendingAsyncHook): void {
    this.hooks.set(hook.id, hook);
  }

  list(): PendingAsyncHook[] {
    return [...this.hooks.values()];
  }

  collectResponses(): AsyncHookResponse[] {
    const responses: AsyncHookResponse[] = [];
    for (const hook of this.hooks.values()) {
      if (hook.responseDelivered || !hook.stdout.trim()) {
        continue;
      }
      const output = parseHookOutput(hook.stdout);
      if (output.type === "async") {
        continue;
      }
      hook.responseDelivered = true;
      responses.push({
        id: hook.id,
        hookName: hook.hookName,
        hookEvent: hook.hookEvent,
        stdout: hook.stdout,
        stderr: hook.stderr,
        output,
        rewake: hook.asyncRewake === true && isBlockingOutput(output),
      });
    }
    return responses;
  }

  removeDelivered(): void {
    for (const hook of this.hooks.values()) {
      if (hook.responseDelivered) {
        this.hooks.delete(hook.id);
      }
    }
  }

  clear(): void {
    this.hooks.clear();
  }
}

function isBlockingOutput(output: PolitDeckHookOutput): boolean {
  return output.type === "sync" && (output.continue === false || output.decision === "block");
}
