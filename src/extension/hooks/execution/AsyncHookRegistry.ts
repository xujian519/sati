export type PendingAsyncHook = {
  id: string;
  startedAt: Date;
  hookName: string;
};

export class AsyncHookRegistry {
  private readonly hooks = new Map<string, PendingAsyncHook>();

  register(hook: PendingAsyncHook): void {
    this.hooks.set(hook.id, hook);
  }

  list(): PendingAsyncHook[] {
    return [...this.hooks.values()];
  }

  clear(): void {
    this.hooks.clear();
  }
}
