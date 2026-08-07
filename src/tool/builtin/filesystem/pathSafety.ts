import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import type { SatiToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";
import { brandEnv, ENV_KEY } from "../../../env.js";

export type SatiPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: SatiToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

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

  const absolutePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(context.cwd, inputPath));

  if (context.permissionMode === "bypassPermissions") {
    const relativePath = path.relative(context.cwd, absolutePath) || ".";
    if (options?.forWrite && isWriteDenied(relativePath)) {
      return {
        ok: false,
        error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
      };
    }
    return { ok: true, absolutePath, relativePath, root: context.cwd };
  }

  const roots = [context.cwd, ...context.permissionContext.additionalWorkingDirectories].map(root =>
    path.resolve(root),
  );
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
      if (options?.forWrite && isWriteDenied(relativePath)) {
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
  if (options?.forWrite && isWriteDenied(relativePath)) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Writing to ${relativePath} is not allowed by default.`),
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

function isWriteDenied(relativePath: string): boolean {
  const firstPart = relativePath.split(path.sep)[0];
  return firstPart !== undefined && DEFAULT_WRITE_DENY_DIRECTORIES.has(firstPart);
}

function safeRealpath(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
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
    return false;
  }
}
