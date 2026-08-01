import type { SatiHooksSettings } from "../../hooks/protocol/settings.js";
import type { SatiLoadedPlugin } from "../protocol/plugin.js";

export function loadPluginHooks(plugins: SatiLoadedPlugin[]): SatiHooksSettings {
  const settings: SatiHooksSettings = {};
  for (const plugin of plugins) {
    for (const [event, matchers] of Object.entries(plugin.hooksConfig ?? {}) as Array<
      [keyof SatiHooksSettings, NonNullable<SatiHooksSettings[keyof SatiHooksSettings]>]
    >) {
      settings[event] = [
        ...(settings[event] ?? []),
        ...matchers.map(matcher => ({
          ...matcher,
          pluginName: plugin.name,
          pluginId: `${plugin.name}@${plugin.source}`,
          pluginRoot: plugin.path,
        })),
      ];
    }
  }
  return settings;
}
