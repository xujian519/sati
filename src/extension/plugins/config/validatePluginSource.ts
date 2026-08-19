import { isAbsolute, relative, resolve } from "node:path";

export function validatePluginSourcePath(pluginPath: string, allowedRoot: string): boolean {
  const resolvedPlugin = resolve(pluginPath);
  const resolvedRoot = resolve(allowedRoot);
  // 分隔符无关的子路径检查：相等时 relative() 返回 `""`；Windows 上
  // resolve 产生 `\`，不能按 `/` 前缀拼串。
  const relativePath = relative(resolvedRoot, resolvedPlugin);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
