export class AgentHookExecutor {
  async execute(): Promise<never> {
    throw new Error("Agent hooks are deferred.");
  }
}
