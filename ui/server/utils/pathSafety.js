/**
 * `ui/server` 侧的路径包含性判定。
 *
 * 与 `src/tool/builtin/filesystem/pathSafety.ts`（工具面）职责不同：这里只做纯词法判定，
 * 供路由守卫使用。调用方若需覆盖软链 / 大小写别名，须自行在 `realpath` 规范化后再判一次
 * （见 `middleware/projectFilesystem.js`）。
 */
import path from "node:path";

/**
 * 判定 `candidate` 是否就是 `root` 本身或位于其下。
 *
 * @param {string} root 包含性边界。
 * @param {string} candidate 待判路径。
 * @returns {boolean} `candidate` 落在 `root` 内或与之相等。
 */
export function isPathInsideOrEqual(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedRoot === resolvedCandidate) {
    return true;
  }
  return resolvedCandidate.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`);
}
