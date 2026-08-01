import type { SatiLoadedPlugin } from "../protocol/plugin.js";

export function discoverBuiltinPlugins(plugins: SatiLoadedPlugin[] = []): SatiLoadedPlugin[] {
  return plugins.filter(plugin => plugin.source === "builtin");
}
