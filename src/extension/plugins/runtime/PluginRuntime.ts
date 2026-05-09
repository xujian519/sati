import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath } from "../loading/PluginLoader.js";
import { loadPluginHooks } from "../loading/PluginHookLoader.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { PolitDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";
import type { PolitDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PolitDeckCustomRouter } from "../../../router/customRouter/customRouter.js";

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

export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  namespace?: string;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

export type PluginContributionSnapshot = {
  plugins: PolitDeckLoadedPlugin[];
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  outputStyles: LoadedPluginCommand[];
  hooks: PolitDeckHooksSettings;
  mcpServers: Record<string, unknown>;
  lspServers: Record<string, unknown>;
  mcpInstructions: PluginMcpInstruction[];
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

  snapshotContributions(): PluginContributionSnapshot {
    const plugins = this.registry.list();
    return {
      plugins,
      commands: plugins.flatMap((plugin) => (plugin.commands ?? []).map((command) => toCommandContribution(plugin, command))),
      skills: plugins.flatMap((plugin) => (plugin.skills ?? []).map((skill) => toSkillContribution(plugin, skill))),
      outputStyles: plugins.flatMap((plugin) => plugin.outputStyles ?? []),
      hooks: loadPluginHooks(plugins),
      mcpServers: this.mcpServers(),
      lspServers: this.lspServers(),
      mcpInstructions: readMcpInstructions(this.mcpServers()),
    };
  }

  getAllCommands(): PluginCommandContribution[] {
    return this.snapshotContributions().commands;
  }

  getAllSkills(): PluginSkillContribution[] {
    return this.snapshotContributions().skills;
  }

  getAllMcpInstructions(): PluginMcpInstruction[] {
    return this.snapshotContributions().mcpInstructions;
  }

  lookupRouter(extensionId: string): PolitDeckCustomRouter | undefined {
    for (const plugin of this.registry.list()) {
      for (const contribution of plugin.routerContributions ?? []) {
        if (contribution.id !== extensionId) {
          continue;
        }
        return contribution.createCustomRouter();
      }
    }
    return undefined;
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    for (const plugin of this.registry.list()) {
      const prompt = plugin.promptContributions?.find((contribution) => contribution.name === extensionId);
      if (prompt) {
        return prompt.content;
      }
      const skill = plugin.skills?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (skill) {
        return skill.content;
      }
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) {
        return command.content;
      }
    }
    return undefined;
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

function toCommandContribution(
  plugin: PolitDeckLoadedPlugin,
  command: LoadedPluginCommand,
): PluginCommandContribution {
  return {
    name: command.name,
    description: typeof command.frontmatter.description === "string" ? command.frontmatter.description : undefined,
    argumentHint:
      typeof command.frontmatter["argument-hint"] === "string"
        ? command.frontmatter["argument-hint"]
        : undefined,
    namespace: plugin.name,
  };
}

function toSkillContribution(
  plugin: PolitDeckLoadedPlugin,
  skill: LoadedPluginCommand,
): PluginSkillContribution {
  return {
    name: skill.name,
    description: typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : undefined,
    namespace: plugin.name,
  };
}

function readMcpInstructions(mcpServers: Record<string, unknown>): PluginMcpInstruction[] {
  return Object.entries(mcpServers).map(([serverName, body]) => ({
    serverName,
    instructions: isRecord(body) && typeof body.instructions === "string" ? body.instructions : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
