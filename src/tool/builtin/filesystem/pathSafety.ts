import path from "node:path";
import { realpathSync } from "node:fs";
import type { PolitDeckToolRuntimeContext } from "../../protocol/types.js";
import type { PolitDeckToolError } from "../../protocol/errors.js";
import { toolError } from "../../protocol/errors.js";

export type PolitDeckPathSafetyResult =
  | { ok: true; absolutePath: string; relativePath: string; root: string }
  | { ok: false; error: PolitDeckToolError };

const DEFAULT_WRITE_DENY_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export function resolvePolitDeckWorkspacePath(
  inputPath: string,
  context: PolitDeckToolRuntimeContext,
  options?: { forWrite?: boolean; mustExist?: boolean },
): PolitDeckPathSafetyResult {
  if (!inputPath || inputPath.includes("\0")) {
    return {
      ok: false,
      error: toolError("invalid_tool_input", "Path must be a non-empty string without null bytes."),
    };
  }

  const roots = [context.cwd, ...context.permissionContext.additionalWorkingDirectories].map((root) =>
    path.resolve(root),
  );
  const absolutePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(context.cwd, inputPath));
  const root = roots.find((candidate) => isPathWithinRoot(absolutePath, candidate));

  if (!root) {
    return {
      ok: false,
      error: toolError("path_not_allowed", `Path ${inputPath} is outside the PolitDeck workspace.`),
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
        error: toolError("path_not_allowed", `Path ${inputPath} resolves outside the PolitDeck workspace.`),
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
