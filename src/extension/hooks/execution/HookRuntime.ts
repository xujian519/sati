import type { PolitDeckHookEffect, PolitDeckLifecycleError } from "../../../lifecycle/protocol/effects.js";
import { matchHookMatcher } from "../config/matchHook.js";
import { matchHookCondition } from "../config/matchHookCondition.js";
import type { PolitDeckHookEvent } from "../protocol/events.js";
import type { PolitDeckHookInput } from "../protocol/input.js";
import type { PolitDeckHookOutput, PolitDeckHookSyncOutput } from "../protocol/output.js";
import type { PolitDeckHookCommand, PolitDeckHooksSettings } from "../protocol/settings.js";
import { CommandHookExecutor, POLITDECK_SESSION_END_HOOK_TIMEOUT_MS } from "./CommandHookExecutor.js";
import { HookExecutionEventBus, type PolitDeckHookExecutionEvent } from "../events/HookExecutionEventBus.js";

export type HookRuntimeRunInput = {
  event: PolitDeckHookEvent;
  hookInput: PolitDeckHookInput;
  matchQuery?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type HookRuntimeRunResult = {
  effects: PolitDeckHookEffect[];
  events: PolitDeckHookExecutionEvent[];
  blockingErrors: PolitDeckLifecycleError[];
  nonBlockingErrors: PolitDeckLifecycleError[];
};

export class HookRuntime {
  constructor(
    private readonly settings: PolitDeckHooksSettings = {},
    private readonly commandExecutor = new CommandHookExecutor(),
    private readonly eventBus = new HookExecutionEventBus(),
  ) {}

  async run(input: HookRuntimeRunInput): Promise<HookRuntimeRunResult> {
    const effects: PolitDeckHookEffect[] = [];
    const events: PolitDeckHookExecutionEvent[] = [];
    const blockingErrors: PolitDeckLifecycleError[] = [];
    const nonBlockingErrors: PolitDeckLifecycleError[] = [];

    for (const { matcher, hook } of this.matchHooks(input)) {
      const hookName = matcher.pluginName ? `${matcher.pluginName}:${hook.type}` : hook.type;
      const started: PolitDeckHookExecutionEvent = {
        type: "started",
        hookName,
        hookEvent: input.event,
      };
      events.push(started);
      this.eventBus.emit(started);

      if (hook.type !== "command") {
        nonBlockingErrors.push({
          code: "hook_non_blocking_error",
          message: `${hook.type} hooks are not implemented yet.`,
          hookName,
        });
        continue;
      }

      const result = await this.commandExecutor.execute({
        hook,
        hookInput: input.hookInput,
        cwd: matcher.pluginRoot ?? input.cwd,
        env: input.env,
        signal: input.signal,
        timeoutMs: input.event === "SessionEnd" ? POLITDECK_SESSION_END_HOOK_TIMEOUT_MS : undefined,
      });
      const response: PolitDeckHookExecutionEvent = {
        type: "response",
        hookName,
        hookEvent: input.event,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        outcome: result.outcome,
      };
      events.push(response);
      this.eventBus.emit(response);

      if (result.outcome === "blocking") {
        const message = result.stderr || result.stdout || "Hook blocked execution.";
        blockingErrors.push({ code: "hook_blocking_error", message, hookName, exitCode: result.exitCode });
        effects.push({ type: "block", reason: message });
      } else if (result.outcome === "non_blocking_error" || result.outcome === "timeout" || result.outcome === "cancelled") {
        nonBlockingErrors.push({
          code: result.outcome === "cancelled" ? "hook_cancelled" : "hook_non_blocking_error",
          message: result.stderr || result.stdout || `Hook ended with outcome ${result.outcome}.`,
          hookName,
          exitCode: result.exitCode,
        });
      }

      effects.push(...effectsFromHookOutput(result.output, hookName));
    }

    return { effects, events, blockingErrors, nonBlockingErrors };
  }

  private *matchHooks(input: HookRuntimeRunInput): Generator<{
    matcher: NonNullable<PolitDeckHooksSettings[PolitDeckHookEvent]>[number];
    hook: PolitDeckHookCommand;
  }> {
    for (const matcher of this.settings[input.event] ?? []) {
      if (!matchHookMatcher(matcher.matcher, input.matchQuery)) {
        continue;
      }
      for (const hook of matcher.hooks) {
        if (
          matchHookCondition(hook.if, {
            toolName: typeof input.hookInput.toolName === "string" ? input.hookInput.toolName : undefined,
            toolInput: input.hookInput.toolInput,
          })
        ) {
          yield { matcher, hook };
        }
      }
    }
  }
}

function effectsFromHookOutput(output: PolitDeckHookOutput, hookName: string): PolitDeckHookEffect[] {
  if (output.type === "async") {
    return [];
  }

  const effects: PolitDeckHookEffect[] = [];
  if (output.systemMessage) {
    effects.push({ type: "system_message", content: output.systemMessage });
  }
  if (isBlockingOutput(output)) {
    effects.push({
      type: "block",
      reason: output.reason ?? output.stopReason ?? "Hook blocked execution.",
      stopReason: output.stopReason,
    });
  }
  if (output.specific) {
    const specific = output.specific;
    if (specific.additionalContext) {
      effects.push({ type: "additional_context", content: specific.additionalContext, source: hookName });
    }
    if (specific.initialUserMessage) {
      effects.push({ type: "initial_user_message", message: specific.initialUserMessage });
    }
    if (specific.watchPaths?.length) {
      effects.push({ type: "watch_paths", paths: specific.watchPaths });
    }
    if (specific.permissionDecision) {
      effects.push({
        type: "permission_decision",
        behavior: specific.permissionDecision,
        reason: specific.permissionDecisionReason,
      });
    }
    if (specific.updatedInput) {
      effects.push({ type: "updated_tool_input", input: specific.updatedInput });
    }
    if (specific.updatedMCPToolOutput !== undefined) {
      effects.push({ type: "updated_mcp_tool_output", output: specific.updatedMCPToolOutput });
    }
    if (specific.decision) {
      effects.push({ type: "permission_request_result", result: specific.decision });
    }
    if (specific.retry) {
      effects.push({ type: "retry_permission_denied" });
    }
  }

  return effects;
}

function isBlockingOutput(output: PolitDeckHookSyncOutput): boolean {
  return output.continue === false || output.decision === "block";
}
