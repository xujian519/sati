import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHooksConfig } from "../../hooks/config/parseHooksConfig.js";
import type { PolitDeckPluginManifest } from "../protocol/manifest.js";
import type { PolitDeckLoadedPlugin, PolitDeckPluginSourceKind } from "../protocol/plugin.js";
import { parsePluginManifest } from "../config/parsePluginManifest.js";

export async function loadPluginFromPath(
  pluginPath: string,
  source: PolitDeckPluginSourceKind,
): Promise<PolitDeckLoadedPlugin> {
  const manifestPath = join(pluginPath, "plugin.json");
  const manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const hooksConfig = await loadHooksConfig(pluginPath, manifest);

  return {
    name: manifest.name,
    path: pluginPath,
    source,
    manifest,
    hooksConfig,
    mcpServers: manifest.mcpServers,
  };
}

async function loadHooksConfig(pluginPath: string, manifest: PolitDeckPluginManifest) {
  if (typeof manifest.hooks === "object" && manifest.hooks !== null) {
    return parseHooksConfig(manifest.hooks).settings;
  }
  const hookPath = typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json";
  try {
    const raw = JSON.parse(await readFile(join(pluginPath, hookPath), "utf8")) as unknown;
    return parseHooksConfig(raw).settings;
  } catch {
    return undefined;
  }
}
