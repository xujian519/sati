import type { PolitDeckHookInput } from "../protocol/input.js";
import type { PolitDeckHookCommand } from "../protocol/settings.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { CommandHookExecutionResult } from "./CommandHookExecutor.js";

export type AgentHookRunner = (input: {
  prompt: string;
  model?: string;
  hookInput: PolitDeckHookInput;
  signal?: AbortSignal;
}) => Promise<string>;

export class AgentHookExecutor {
  constructor(private readonly runner?: AgentHookRunner) {}

  async execute(options: {
    hook: Extract<PolitDeckHookCommand, { type: "agent" }>;
    hookInput: PolitDeckHookInput;
    signal?: AbortSignal;
  }): Promise<CommandHookExecutionResult> {
    if (!this.runner) {
      return {
        stdout: "",
        stderr: "Agent hook runner is not configured.",
        outcome: "non_blocking_error",
        output: { type: "sync" },
      };
    }

    try {
      const stdout = await this.runner({
        prompt: options.hook.prompt.replace("$ARGUMENTS", JSON.stringify(options.hookInput)),
        model: options.hook.model,
        hookInput: options.hookInput,
        signal: options.signal,
      });
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        outcome: "success",
        output: parseHookOutput(stdout),
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outcome: "non_blocking_error",
        output: { type: "sync" },
      };
    }
  }
}
