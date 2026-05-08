import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, PolitDeckLoadedPlugin>();

  replaceAll(plugins: PolitDeckLoadedPlugin[]): void {
    this.plugins.clear();
    for (const plugin of plugins) {
      this.plugins.set(`${plugin.name}@${plugin.source}`, plugin);
    }
  }

  list(): PolitDeckLoadedPlugin[] {
    return [...this.plugins.values()];
  }
}
