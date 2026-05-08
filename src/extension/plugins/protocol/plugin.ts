import type { PolitDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { PolitDeckPluginManifest } from "./manifest.js";

export type PolitDeckPluginSourceKind = "builtin" | "global" | "project";

export type PolitDeckLoadedPlugin = {
  name: string;
  path: string;
  source: PolitDeckPluginSourceKind;
  manifest: PolitDeckPluginManifest;
  hooksConfig?: PolitDeckHooksSettings;
  commands?: LoadedPluginCommand[];
  skills?: LoadedPluginCommand[];
  outputStyles?: LoadedPluginCommand[];
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
};
