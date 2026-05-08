import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath } from "../loading/PluginLoader.js";
import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";

export type PluginRuntimeOptions = {
  projectRoot: string;
  politHome: string;
  builtinPlugins?: PolitDeckLoadedPlugin[];
};

export class PluginRuntime {
  private readonly registry = new PluginRegistry();

  constructor(private readonly options: PluginRuntimeOptions) {}

  snapshot(): PolitDeckLoadedPlugin[] {
    return this.registry.list();
  }

  async refresh(): Promise<PolitDeckLoadedPlugin[]> {
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      politHome: this.options.politHome,
    });
    const discovered = await discoverPluginPaths([
      { path: paths.globalPluginsDir, source: "global" },
      { path: paths.projectPluginsDir, source: "project" },
    ]);
    const loaded = await Promise.all(
      discovered.map((plugin) => loadPluginFromPath(plugin.path, plugin.source).catch(() => undefined)),
    );
    const plugins = [...(this.options.builtinPlugins ?? []), ...loaded.filter(isLoadedPlugin)];
    this.registry.replaceAll(plugins);
    return plugins;
  }
}

function isLoadedPlugin(value: PolitDeckLoadedPlugin | undefined): value is PolitDeckLoadedPlugin {
  return value !== undefined;
}
