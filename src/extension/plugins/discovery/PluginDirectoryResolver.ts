import type { PolitExtensionPaths } from "../../../polit/paths.js";
import { getPolitExtensionPaths } from "../../../polit/paths.js";

export type PluginDirectoryResolverInput = {
  projectRoot: string;
  politHome: string;
};

export function resolvePluginDirectories(input: PluginDirectoryResolverInput): PolitExtensionPaths {
  return getPolitExtensionPaths(input.projectRoot, input.politHome);
}
