import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SatiPluginSourceKind } from "../protocol/plugin.js";

export type DiscoveredPluginPath = {
  path: string;
  source: SatiPluginSourceKind;
};

export async function discoverPluginPaths(
  directories: Array<{ path: string; source: SatiPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      // 插件根目录不存在/不可读：跳过该发现根，不阻断其他根（fail-safe）。
      continue;
    }

    for (const entry of entries) {
      const pluginPath = join(directory.path, entry);
      try {
        if ((await stat(pluginPath)).isDirectory()) {
          discovered.push({ path: pluginPath, source: directory.source });
        }
      } catch {
        // 条目 stat 失败（竞态删除/权限）：跳过该条目（fail-safe）。
        continue;
      }
    }
  }
  return discovered;
}

/**
 * Discovers standalone skill directories (containing SKILL.md without plugin.json).
 * Mirrors the legacy standalone skill directory convention.
 */
export async function discoverSkillPaths(
  directories: Array<{ path: string; source: SatiPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      // 技能根目录不存在/不可读：跳过该发现根，不阻断其他根（fail-safe）。
      continue;
    }
    for (const entry of entries) {
      const skillDir = join(directory.path, entry);
      try {
        if (!(await stat(skillDir)).isDirectory()) continue;
        const files = await readdir(skillDir);
        if (files.some(f => /^skill\.md$/i.test(f))) {
          discovered.push({ path: skillDir, source: directory.source });
        }
      } catch {
        // 目录/stat/readdir 失败（竞态删除/权限）：跳过该条目（fail-safe）。
        continue;
      }
    }
  }
  return discovered;
}
