import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PolitDeckPluginSourceKind } from "../protocol/plugin.js";

export type DiscoveredPluginPath = {
  path: string;
  source: PolitDeckPluginSourceKind;
};

export async function discoverPluginPaths(
  directories: Array<{ path: string; source: PolitDeckPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginPath = join(directory.path, entry);
      try {
        if ((await stat(pluginPath)).isDirectory()) {
          discovered.push({ path: pluginPath, source: directory.source });
        }
      } catch {
        continue;
      }
    }
  }
  return discovered;
}
