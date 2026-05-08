import type { PolitDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PolitDeckPluginManifest } from "./manifest.js";

export type PolitDeckPluginSourceKind = "builtin" | "global" | "project";

export type PolitDeckLoadedPlugin = {
  name: string;
  path: string;
  source: PolitDeckPluginSourceKind;
  manifest: PolitDeckPluginManifest;
  hooksConfig?: PolitDeckHooksSettings;
  mcpServers?: Record<string, unknown>;
};
