import type { SatiLoadedPlugin } from "../protocol/plugin.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, SatiLoadedPlugin>();

  replaceAll(plugins: SatiLoadedPlugin[]): void {
    this.plugins.clear();
    for (const plugin of plugins) {
      this.plugins.set(`${plugin.name}@${plugin.source}`, plugin);
    }
  }

  list(): SatiLoadedPlugin[] {
    return [...this.plugins.values()];
  }
}
