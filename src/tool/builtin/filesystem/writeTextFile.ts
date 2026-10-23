import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { resolveRealWritePath } from "./pathSafety.js";
import { type VerifiedWriteTarget, hardlinkTargetError, writeTargetChangedError } from "./writeTarget.js";

/**
 * 把内容写到**已解析的真实落点**，并在打开后按 fd 复核身份：
 *
 * - 打开 `realPath`（而非调用方的词法路径），解析后软链被重指也改不了写入去路；
 * - `O_NOFOLLOW` 拒绝末级组件在窗口内变成软链；创建走 `O_EXCL`，目标在窗口内
 *   出现即失败而不是覆盖；
 * - `fstat(fd)` 与解析时的 dev/ino 对拍（目标被替换即中止），并复查 nlink
 *   （窗口内新挂硬链接同样按策略拒绝）；
 * - 打开后再解析一次词法路径，落点变了就中止；新建的文件在失败时回滚。
 */
export async function writeTextFile(
  target: VerifiedWriteTarget,
  content: string,
  options?: { allowOverwrite?: boolean },
): Promise<"created" | "overwritten"> {
  const { absolutePath, realPath, existing } = target;

  if (existing && !options?.allowOverwrite) {
    throw new SatiToolRuntimeError(
      "file_conflict",
      `${absolutePath} already exists. Set allow_overwrite to true to overwrite it.`,
    );
  }

  if (!existing) {
    await mkdir(path.dirname(realPath), { recursive: true });
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = existing
    ? constants.O_WRONLY | noFollow
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(realPath, flags, 0o666);
  } catch (error) {
    throw mapOpenError(error, target);
  }

  let fdIdentity: { dev: number; ino: number } | undefined;
  try {
    const fdStat = await handle.stat();
    fdIdentity = { dev: fdStat.dev, ino: fdStat.ino };

    if (!fdStat.isFile()) {
      throw new SatiToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
    }
    if (existing && (fdStat.dev !== existing.dev || fdStat.ino !== existing.ino)) {
      throw writeTargetChangedError(absolutePath, realPath);
    }
    if (target.enforceLinkPolicy && target.insideWorkspace && fdStat.nlink > 1) {
      throw hardlinkTargetError(absolutePath, fdStat.nlink);
    }

    // 打开后再解析一次词法路径：软链重指、祖先目录被替换都会在这里分叉。
    if (resolveRealWritePath(absolutePath) !== realPath) {
      throw writeTargetChangedError(absolutePath, realPath);
    }

    if (existing) {
      await handle.truncate(0);
    }
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (!existing && fdIdentity) {
      const rolledBack = await rollbackCreatedFile(realPath, fdIdentity);
      if (!rolledBack) {
        throw new SatiToolRuntimeError(
          "path_not_allowed",
          `${error instanceof Error ? error.message : String(error)} The file created at ${realPath} could not be removed; delete it manually.`,
          error instanceof SatiToolRuntimeError ? error.details : undefined,
        );
      }
    }
    throw error;
  } finally {
    await handle.close();
  }

  return existing ? "overwritten" : "created";
}

function mapOpenError(error: unknown, target: VerifiedWriteTarget): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") {
    return writeTargetChangedError(target.absolutePath, target.realPath);
  }
  if (code === "EEXIST") {
    return new SatiToolRuntimeError(
      "file_conflict",
      `${target.absolutePath} appeared after the write target was resolved. Retry the write.`,
    );
  }
  if (code === "EISDIR" || code === "ENOTDIR") {
    return new SatiToolRuntimeError("file_conflict", `${target.absolutePath} is not a regular file.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** 仅当路径仍指向我们刚创建的那个 inode 时才删除，避免误删窗口内被换入的其他文件。 */
async function rollbackCreatedFile(realPath: string, identity: { dev: number; ino: number }): Promise<boolean> {
  try {
    const current = await lstat(realPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      return false;
    }
    await unlink(realPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return true;
    }
    return false;
  }
}
