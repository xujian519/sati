import type { SatiHooksSettings } from "../../hooks/protocol/settings.js";

export type SatiPluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | SatiHooksSettings;
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  outputStyles?: string | string[];
  marketplace?: SatiMarketplaceReference;
  mcpb?: string;
  settings?: Record<string, unknown>;
};

export type SatiMarketplaceReference = {
  name: string;
  plugin: string;
  version?: string;
  source?: "marketplace" | "git" | "zip" | "mcpb";
  url?: string;
};
