import type { PolitDeckHooksSettings } from "../../hooks/protocol/settings.js";

export type PolitDeckPluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | PolitDeckHooksSettings;
  mcpServers?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};
