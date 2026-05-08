import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath } from "../loading/PluginLoader.js";
import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";

export type PluginRuntimeOptions = {
  projectRoot: string;
  politHome: string;
  builtinPlugins?: PolitDeckLoadedPlugin[];
  builtinPluginsEnabled?: Record<string, boolean>;
};

export type PluginRefreshResult = {
  previous: PolitDeckLoadedPlugin[];
  next: PolitDeckLoadedPlugin[];
  added: PolitDeckLoadedPlugin[];
  removed: PolitDeckLoadedPlugin[];
};

export class PluginRuntime {
  private readonly registry = new PluginRegistry();

  constructor(private readonly options: PluginRuntimeOptions) {}

  snapshot(): PolitDeckLoadedPlugin[] {
    return this.registry.list();
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  lspServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>;
  }

  async refresh(): Promise<PolitDeckLoadedPlugin[]> {
    return (await this.refreshWithReport()).next;
  }

  async refreshWithReport(): Promise<PluginRefreshResult> {
    const previous = this.registry.list();
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
    const plugins = [
      ...enabledBuiltinPlugins(this.options.builtinPlugins ?? [], this.options.builtinPluginsEnabled ?? {}),
      ...loaded.filter(isLoadedPlugin),
    ];
    this.registry.replaceAll(plugins);
    return {
      previous,
      next: plugins,
      added: plugins.filter((plugin) => !hasPlugin(previous, plugin)),
      removed: previous.filter((plugin) => !hasPlugin(plugins, plugin)),
    };
  }
}

function isLoadedPlugin(value: PolitDeckLoadedPlugin | undefined): value is PolitDeckLoadedPlugin {
  return value !== undefined;
}

function enabledBuiltinPlugins(
  plugins: PolitDeckLoadedPlugin[],
  enabled: Record<string, boolean>,
): PolitDeckLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source !== "builtin" || enabled[plugin.name] !== false);
}

function hasPlugin(plugins: PolitDeckLoadedPlugin[], plugin: PolitDeckLoadedPlugin): boolean {
  return plugins.some((candidate) => candidate.name === plugin.name && candidate.source === plugin.source);
}
