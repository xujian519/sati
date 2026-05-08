import type { PolitDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";

export function loadPluginHooks(plugins: PolitDeckLoadedPlugin[]): PolitDeckHooksSettings {
  const settings: PolitDeckHooksSettings = {};
  for (const plugin of plugins) {
    for (const [event, matchers] of Object.entries(plugin.hooksConfig ?? {}) as Array<
      [keyof PolitDeckHooksSettings, NonNullable<PolitDeckHooksSettings[keyof PolitDeckHooksSettings]>]
    >) {
      settings[event] = [
        ...(settings[event] ?? []),
        ...matchers.map((matcher) => ({
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
