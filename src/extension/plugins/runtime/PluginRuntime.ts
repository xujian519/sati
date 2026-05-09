import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath } from "../loading/PluginLoader.js";
import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";
import { truncateMcpInstructionString } from "./truncateMcpString.js";

/**
 * Static MCP server contribution shape callers can rely on. Manifests load
 * `mcpServers` as `Record<string, unknown>` to stay forward-compatible, so
 * this type is *advisory* — the runtime only reads `instructions` and falls
 * back gracefully when missing.
 */
export type PolitDeckMcpServerStaticSpec = {
  instructions?: string;
  [key: string]: unknown;
};

export type PolitDeckMcpInstructionEntry = {
  serverName: string;
  instructions: string;
};

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

  /**
   * Read-only static instructions aggregator (deferred-feature §5.3 / B3).
   * - Iterates `mcpServers` from every loaded plugin.
   * - Filters entries with a non-empty `instructions: string` field.
   * - Truncates each entry to {@link truncateMcpInstructionString} (2048 chars).
   * - Returns a stable list sorted by `serverName` (avoids prompt-cache thrash).
   *
   * Once C1 (real MCP runtime) lands, the runtime can layer dynamic
   * instructions on top via the same `getAllMcpInstructions` aggregator
   * surface used by `PluginRuntimeExtensionResolver`.
   */
  getAllMcpInstructions(): PolitDeckMcpInstructionEntry[] {
    const entries: PolitDeckMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.registry.list()) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = (raw as PolitDeckMcpServerStaticSpec).instructions;
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(trimmed),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
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
