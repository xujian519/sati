import type { SatiHooksSettings } from "../../hooks/protocol/settings.js";
import type { PromptContribution } from "../../contributions/PromptContribution.js";
import type { RouterContribution } from "../../contributions/RouterContribution.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { SatiPluginManifest } from "./manifest.js";

export type SatiPluginSourceKind = "builtin" | "global" | "project";

export type SatiLoadedPlugin = {
  name: string;
  path: string;
  source: SatiPluginSourceKind;
  manifest: SatiPluginManifest;
  hooksConfig?: SatiHooksSettings;
  commands?: LoadedPluginCommand[];
  skills?: LoadedPluginCommand[];
  outputStyles?: LoadedPluginCommand[];
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  /**
   * Programmatic contributions are currently only available to builtin or
   * test-injected plugins. Disk-loaded JSON plugins cannot provide functions.
   */
  promptContributions?: PromptContribution[];
  routerContributions?: RouterContribution[];
};
