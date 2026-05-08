import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";

export function discoverBuiltinPlugins(plugins: PolitDeckLoadedPlugin[] = []): PolitDeckLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source === "builtin");
}
