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
  lspServers?: Record<string, unknown>;
  outputStyles?: string | string[];
  marketplace?: PolitDeckMarketplaceReference;
  mcpb?: string;
  settings?: Record<string, unknown>;
};

export type PolitDeckMarketplaceReference = {
  name: string;
  plugin: string;
  version?: string;
  source?: "marketplace" | "git" | "zip" | "mcpb";
  url?: string;
};
