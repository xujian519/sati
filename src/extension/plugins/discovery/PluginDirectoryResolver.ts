import type { PilotExtensionPaths } from "../../../shared/paths/index.js";
import { getPilotExtensionPaths } from "../../../shared/paths/index.js";

export type PluginDirectoryResolverInput = {
  projectRoot: string;
  pilotHome: string;
};

export function resolvePluginDirectories(input: PluginDirectoryResolverInput): PilotExtensionPaths {
  return getPilotExtensionPaths(input.projectRoot, input.pilotHome);
}
