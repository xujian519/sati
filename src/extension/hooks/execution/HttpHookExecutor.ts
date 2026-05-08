export class HttpHookExecutor {
  async execute(): Promise<never> {
    throw new Error("HTTP hooks are deferred.");
  }
}
