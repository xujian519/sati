import path from "node:path";
import { readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import type { SatiToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";
import { brandEnv, ENV_KEY } from "../../../env.js";

export type SatiPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: SatiToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);
const MAX_SYMLINK_HOPS = 40;

export function resolveSatiWorkspacePath(
  inputPath: string,
  context: SatiToolRuntimeContext,
  options?: {
    forWrite?: boolean;
    mustExist?: boolean;
    allowOutsideWorkspace?: boolean;
    allowRegisteredReadFiles?: boolean;
  },
): SatiPathSafetyResult {
  if (!inputPath || inputPath.includes("\0")) {
    return {
      ok: false,
      error: toolError("invalid_tool_input", "Path must be a non-empty string without null bytes."),
    };
  }

  // resolve(cwd, p) 对绝对/相对输入统一产出规范化绝对路径。
  const absolutePath = path.resolve(context.cwd, inputPath);

  // 写操作由 OS 跟随符号链接落盘，因此授权必须对**真实落点**成立，而不只是调用方
  // 给的这条字面路径：工作区里一个指向外部的软链（含悬空/循环）能让词法上在 root
  // 内的路径落到 root 外。
  const realWritePath = options?.forWrite ? resolveRealWritePath(absolutePath) : undefined;
  if (options?.forWrite && !realWritePath) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} has too many symbolic links to resolve safely.`),
    };
  }

  const roots = [context.cwd, ...context.permissionContext.additionalWorkingDirectories].map(root =>
    path.resolve(root),
  );

  if (context.permissionMode === "bypassPermissions") {
    const relativePath = path.relative(context.cwd, absolutePath) || ".";
    if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, roots))) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
      };
    }
    return { ok: true, absolutePath, relativePath, root: context.cwd };
  }

  const root = roots.find(candidate => isPathWithinRoot(absolutePath, candidate));

  if (!root) {
    if (!options?.forWrite && options?.allowRegisteredReadFiles) {
      const real = safeRealpath(absolutePath);
      if (!real) {
        return {
          ok: false,
          error: toolError("file_not_found", `File ${inputPath} does not exist.`),
        };
      }
      const allowed = (context.allowedReadFiles ?? []).some(allowedPath => {
        const allowedReal = safeRealpath(allowedPath) ?? path.resolve(allowedPath);
        return real === allowedReal;
      });
      if (allowed || isManagedImAttachmentFile(real, context)) {
        const relativePath = path.relative(context.cwd, absolutePath) || ".";
        return { ok: true, absolutePath, relativePath, root: context.cwd };
      }
    }

    if (options?.allowOutsideWorkspace) {
      const relativePath = path.relative(context.cwd, absolutePath) || ".";
      if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, roots))) {
        return {
          ok: false,
          error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
        };
      }
      return { ok: true, absolutePath, relativePath, root: context.cwd };
    }

    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} is outside the Sati workspace.`),
    };
  }

  const relativePath = path.relative(root, absolutePath) || ".";
  if (options?.forWrite && (isWriteDenied(relativePath) || isRealWriteDenied(realWritePath, roots))) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
    };
  }

  // 词法在 root 内 ≠ 真实落点在 root 内：这一条才是拦「工作区内软链指向工作区外」的闸。
  if (realWritePath && !findRealRoot(realWritePath, roots) && !options?.allowOutsideWorkspace) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the Sati workspace.`),
    };
  }

  if (options?.mustExist) {
    const real = safeRealpath(absolutePath);
    if (!real) {
      return {
        ok: false,
        error: toolError("file_not_found", `File ${inputPath} does not exist.`),
      };
    }

    const realRoot = safeRealpath(root) ?? root;
    if (!isPathWithinRoot(real, realRoot)) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the Sati workspace.`),
      };
    }
  }

  return { ok: true, absolutePath, relativePath, root };
}

export function toWorkspaceRelativePath(absolutePath: string, root: string): string {
  return path.relative(root, absolutePath) || ".";
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 解析一次写入**实际会落到**的路径（OS 跟随符号链接之后），包括目标尚不存在
 * （含悬空软链）的情形。逐组件解析：处理完一个组件才处理后续 `..`，与 OS 遍历
 * 软链目标的顺序一致。软链跳数超过上限返回 `undefined`（调用方按拒绝处理）。
 */
export function resolveRealWritePath(absolutePath: string): string | undefined {
  const real = safeRealpath(absolutePath);
  if (real) return real;

  let current = path.parse(absolutePath).root;
  const pending = absolutePath.slice(current.length).split(path.sep);
  let linkHops = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (!component || component === ".") continue;
    if (component === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, component);
    const linkTarget = safeReadlink(candidate);
    if (linkTarget !== undefined) {
      linkHops += 1;
      if (linkHops > MAX_SYMLINK_HOPS) {
        return undefined;
      }
      if (path.isAbsolute(linkTarget)) {
        current = path.parse(linkTarget).root;
        pending.unshift(...linkTarget.slice(current.length).split(path.sep));
      } else {
        pending.unshift(...linkTarget.split(path.sep));
      }
      continue;
    }
    // 末级文件不存在时也要规范化已存在的组件，让大小写不敏感文件系统上的目录别名
    // 保留其真实拼写。
    current = safeRealpath(candidate) ?? candidate;
  }
  return current;
}

function isWriteDenied(relativePath: string): boolean {
  const firstPart = relativePath.split(path.sep)[0];
  return firstPart !== undefined && DEFAULT_WRITE_DENY_DIRECTORIES.has(firstPart);
}

function isRealWriteDenied(realWritePath: string | undefined, roots: string[]): boolean {
  if (!realWritePath) {
    return false;
  }
  return roots.some(root => {
    return [...DEFAULT_WRITE_DENY_DIRECTORIES].some(directory => {
      // 用与写目标相同的逐组件逻辑解析保护目录：这样悬空保护目录软链（最终目标
      // 尚不存在）也能被识别。循环保护链没有可保护的落点，返回 false。
      const protectedRoot = resolveRealWritePath(path.join(root, directory));
      return protectedRoot !== undefined && isPathWithinRoot(realWritePath, protectedRoot);
    });
  });
}

function findRealRoot(realPath: string, roots: string[]): string | undefined {
  return roots
    .map(root => safeRealpath(root) ?? path.resolve(root))
    .find(realRoot => isPathWithinRoot(realPath, realRoot));
}

function safeRealpath(value: string): string | undefined {
  try {
    // 用原生实现：JS 实现可能在遍历前就把软链目标里的 `..` 折叠掉。
    return realpathSync.native(value);
  } catch {
    // realpath 失败（不存在/断链）→ 返回 undefined（按未解析路径处理）。
    return undefined;
  }
}

function safeReadlink(value: string): string | undefined {
  try {
    return readlinkSync(value);
  } catch {
    // 不是符号链接（或不可读）→ 视为无链接。
    return undefined;
  }
}

function isManagedImAttachmentFile(realPath: string, context: SatiToolRuntimeContext): boolean {
  const pilotHome = path.resolve(brandEnv(context.env, ENV_KEY.HOME) ?? path.join(homedir(), ".sati"));
  const root = safeRealpath(path.join(pilotHome, "im-attachments")) ?? path.join(pilotHome, "im-attachments");
  return isPathWithinRoot(realPath, root) && isRegularFile(realPath);
}

function isRegularFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    // stat 失败（不存在）→ 视为非常规文件。
    return false;
  }
}
