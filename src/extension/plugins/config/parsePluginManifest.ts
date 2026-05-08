import type { PolitDeckPluginManifest } from "../protocol/manifest.js";

export function parsePluginManifest(raw: unknown): PolitDeckPluginManifest {
  if (!isRecord(raw)) {
    throw new Error("Plugin manifest must be an object.");
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error("Plugin manifest must contain a name.");
  }

  return {
    name: raw.name,
    version: stringOrUndefined(raw.version),
    description: stringOrUndefined(raw.description),
    commands: stringOrStringArray(raw.commands),
    agents: stringOrStringArray(raw.agents),
    skills: stringOrStringArray(raw.skills),
    hooks: isRecord(raw.hooks) || typeof raw.hooks === "string" ? raw.hooks : undefined,
    mcpServers: isRecord(raw.mcpServers) ? raw.mcpServers : undefined,
    settings: isRecord(raw.settings) ? raw.settings : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrStringArray(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}
