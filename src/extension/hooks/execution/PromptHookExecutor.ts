export class PromptHookExecutor {
  async execute(): Promise<never> {
    throw new Error("Prompt hooks are deferred.");
  }
}
