import { basename, dirname, relative } from "node:path";

export function getPluginCommandName(pluginName: string, filePath: string, baseDir: string): string {
  const baseName = isSkillFile(filePath) ? basename(dirname(filePath)) : basename(filePath).replace(/\.md$/iu, "");
  const namespaceRoot = isSkillFile(filePath) ? dirname(dirname(filePath)) : dirname(filePath);
  const namespace = relative(baseDir, namespaceRoot)
    .split(/[\\/]/u)
    .filter(Boolean)
    .join(":");

  return namespace ? `${pluginName}:${namespace}:${baseName}` : `${pluginName}:${baseName}`;
}

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/iu.test(basename(filePath));
}
