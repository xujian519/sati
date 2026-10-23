import path from "node:path";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { isPathWithinRoot, resolveRealWritePath, resolveSatiWorkspacePath } from "./pathSafety.js";
import { statIfExists } from "./writeSnapshots.js";

/** 打开前看到的目标身份（dev/ino）；目标不存在时为 undefined。 */
export type FileIdentity = { dev: number; ino: number };

export type VerifiedWriteTarget = {
  /** 调用方给的词法绝对路径。 */
  absolutePath: string;
  /** OS 跟随软链后的真实落点（无软链组件）。 */
  realPath: string;
  /** 解析时该落点已存在则为其身份；不存在（含悬空链）为 undefined。 */
  existing?: FileIdentity;
  /** 词法落点是否在某个工作区 root 内（硬链接策略只作用于工作区内写入）。 */
  insideWorkspace: boolean;
  /** `bypassPermissions` 是用户显式选择「全都批准」，链接策略同样不介入。 */
  enforceLinkPolicy: boolean;
};

export const HARDLINK_TARGET_REASON = "hardlink_target";
export const WRITE_TARGET_CHANGED_REASON = "write_target_changed";

/**
 * 为一次写入解析并复核真实落点。写路径（`forWrite`）在 pathSafety 中已经过一次
 * 真实落点校验；这里在**落盘前**重跑一次，把「校验 → 写入」之间被重指/替换的
 * 目标挡在打开之前。词法在 root 外的目标（用户显式批准的外部目录）仍走
 * `allowOutsideWorkspace` 分支，不因这里收紧。
 */
export async function resolveVerifiedWriteTarget(
  absolutePath: string,
  context: SatiToolRuntimeContext,
): Promise<VerifiedWriteTarget> {
  const resolved = resolveSatiWorkspacePath(absolutePath, context, { forWrite: true, allowOutsideWorkspace: true });
  if (!resolved.ok) {
    throw new SatiToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
  }

  const realPath = resolveRealWritePath(resolved.absolutePath);
  if (!realPath) {
    throw new SatiToolRuntimeError(
      "path_not_allowed",
      `Path ${absolutePath} has too many symbolic links to resolve safely.`,
    );
  }

  const insideWorkspace = isLexicallyInsideWorkspace(resolved.absolutePath, context);
  const enforceLinkPolicy = context.permissionMode !== "bypassPermissions";
  const targetStat = await statIfExists(realPath);
  if (targetStat && !targetStat.isFile()) {
    throw new SatiToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
  }
  if (targetStat && enforceLinkPolicy && insideWorkspace && targetStat.nlink > 1) {
    throw hardlinkTargetError(absolutePath, targetStat.nlink);
  }

  // 测试缝：模拟「解析完成、落盘之前」软链被重指 / 目标被换入硬链接。
  await context.__testBeforeWrite?.();

  return {
    absolutePath: resolved.absolutePath,
    realPath,
    existing: targetStat ? { dev: targetStat.dev, ino: targetStat.ino } : undefined,
    insideWorkspace,
    enforceLinkPolicy,
  };
}

export function hardlinkTargetMessage(absolutePath: string, nlink: number): string {
  return (
    `Refusing to write ${absolutePath}: it has ${nlink} hard links, so the write can also change a file outside the workspace. ` +
    "Copy the file (which breaks the link) and write the copy, or remove the extra link first."
  );
}

export function hardlinkTargetError(absolutePath: string, nlink: number): SatiToolRuntimeError {
  return new SatiToolRuntimeError("path_not_allowed", hardlinkTargetMessage(absolutePath, nlink), {
    reason: HARDLINK_TARGET_REASON,
    nlink,
    path: absolutePath,
  });
}

export function writeTargetChangedError(absolutePath: string, realPath: string): SatiToolRuntimeError {
  return new SatiToolRuntimeError(
    "path_not_allowed",
    `Path ${absolutePath} changed between permission resolution and the write. Read it again and retry.`,
    { reason: WRITE_TARGET_CHANGED_REASON, path: absolutePath, resolvedPath: realPath },
  );
}

export function isLexicallyInsideWorkspace(absolutePath: string, context: SatiToolRuntimeContext): boolean {
  return [context.cwd, ...context.permissionContext.additionalWorkingDirectories]
    .map(root => path.resolve(root))
    .some(root => isPathWithinRoot(absolutePath, root));
}
