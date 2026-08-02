import type { SatiLoadedPlugin } from "../../extension/index.js";
import { isRoleFrontmatter, parseRoleConfig } from "../../extension/skills/roleConfig.js";
import type { SatiMcpServerInstructions } from "../../mcp/protocol/types.js";
import type {
  ContributedCommand,
  ContributedSkill,
  ExtensionResolver,
  McpServerInstruction,
} from "./ExtensionResolver.js";

/**
 * Minimal runtime contract; extension owner has agreed to expose
 * `getAllCommands()` / `getAllSkills()` aggregators (review 2026-05). Until
 * those exist, we accept just `snapshot()` and flatMap manually with a TODO
 * marker.
 *
 * `ExtensionSnapshot` (turn-stable contribution view) is the long-term API;
 * this resolver will be migrated to read it once the extension owner ships it.
 */
export type PluginRuntimeLike = {
  snapshot(): SatiLoadedPlugin[];
  /** Optional aggregator preferred when available. */
  getAllCommands?(): ContributedCommand[];
  getAllSkills?(): ContributedSkill[];
  /** Optional aggregator for MCP instructions. Phase 6 leaves this empty. */
  getAllMcpInstructions?(): McpServerInstruction[];
};

export type PluginRuntimeExtensionResolverOptions = {
  /**
   * Optional runtime-fetched MCP server instructions (B3 upgrade path).
   * Merged on top of the static plugin-declared instructions so the prompt
   * assembler sees both sources. Injected by the gateway because live MCP
   * servers are owned by `McpRuntime`, not by the plugin runtime.
   */
  runtimeMcpInstructions?: () => SatiMcpServerInstructions[];
};

/**
 * Wraps a `PluginRuntime` (or compatible) so context can read plugin-derived
 * info without reaching into `SatiLoadedPlugin` directly.
 *
 * Decision §3.2 — read-only resolver, no separate registry. When extension
 * owner ships the `ExtensionSnapshot` API this implementation should switch
 * to consume it (deferred `context-extension-snapshot`).
 */
export class PluginRuntimeExtensionResolver implements ExtensionResolver {
  private readonly runtimeMcpInstructions?: () => SatiMcpServerInstructions[];

  constructor(
    private readonly runtime: PluginRuntimeLike,
    options: PluginRuntimeExtensionResolverOptions = {},
  ) {
    this.runtimeMcpInstructions = options.runtimeMcpInstructions;
  }

  listCommands(): ContributedCommand[] {
    if (this.runtime.getAllCommands) {
      return this.runtime.getAllCommands();
    }
    return this.runtime.snapshot().flatMap(plugin =>
      (plugin.commands ?? []).map(
        (command): ContributedCommand => ({
          name: command.name,
          description:
            typeof command.frontmatter?.description === "string" ? command.frontmatter.description : undefined,
          argumentHint:
            typeof command.frontmatter?.["argument-hint"] === "string"
              ? (command.frontmatter["argument-hint"] as string)
              : undefined,
          namespace: plugin.name,
        }),
      ),
    );
  }

  listSkills(): ContributedSkill[] {
    if (this.runtime.getAllSkills) {
      return this.runtime.getAllSkills();
    }
    return this.runtime.snapshot().flatMap(plugin =>
      (plugin.skills ?? []).map((skill): ContributedSkill => {
        const fm = skill.frontmatter ?? {};
        return {
          name: skill.name,
          description: typeof fm.description === "string" ? fm.description : undefined,
          path: skill.path,
          namespace: plugin.name,
          role: isRoleFrontmatter(fm) ? parseRoleConfig(fm) : undefined,
        };
      }),
    );
  }

  listMcpInstructions(): McpServerInstruction[] {
    const staticList = this.runtime.getAllMcpInstructions ? this.runtime.getAllMcpInstructions() : [];
    const runtimeList: McpServerInstruction[] = (this.runtimeMcpInstructions?.() ?? []).map(entry => ({
      serverName: entry.serverId,
      instructions: entry.instructions,
    }));
    return [...staticList, ...runtimeList];
  }
}
