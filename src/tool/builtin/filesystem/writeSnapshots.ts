import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { SatiToolRuntimeContext, SatiWriteSnapshotEntry } from "../../protocol/types.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { readTextFile } from "./readTextFile.js";
import { classifyWriteIntent } from "./observation.js";

export function getWriteSnapshot(
  context: SatiToolRuntimeContext,
  absolutePath: string,
): SatiWriteSnapshotEntry | undefined {
  return context.writeSnapshots?.get(absolutePath);
}

export function recordWriteSnapshot(
  context: SatiToolRuntimeContext,
  absolutePath: string,
  content: string,
  mtimeMs: number,
  range?: { offset?: number; limit?: number },
): void {
  context.writeSnapshots ??= new Map();
  context.writeSnapshots.set(absolutePath, {
    absolutePath,
    mtimeMs: Math.floor(mtimeMs),
    contentHash: hashText(content),
    offset: range?.offset,
    limit: range?.limit,
  });
}

export function invalidateReadFileState(context: { readFileState?: Map<string, unknown> }, absolutePath: string): void {
  if (!context.readFileState) return;
  const prefix = `${absolutePath}::`;
  for (const key of context.readFileState.keys()) {
    if (key.startsWith(prefix)) {
      context.readFileState.delete(key);
    }
  }
}

/** stat 但把 ENOENT 归一为 undefined（其余错误照常抛出）。 */
export async function statIfExists(absolutePath: string): Promise<Stats | undefined> {
  return stat(absolutePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

/**
 * 判定快照守卫抛出的 SatiToolRuntimeError 是否为"未读/已变更"类
 * （write_file / edit_file 的 validateInput 将其转为 schema issue 而非异常）。
 * 返回该消息；非此类错误返回 undefined（调用方应继续向上抛）。
 */
export function snapshotGuardIssueMessage(error: unknown): string | undefined {
  if (!(error instanceof SatiToolRuntimeError)) {
    return undefined;
  }
  if (
    error.message === "File has not been read yet. Read it first before writing to it." ||
    error.message === "File has changed since the last read. Read it again before writing to it."
  ) {
    return error.message;
  }
  return undefined;
}

export async function validateWriteSnapshotFresh(
  context: SatiToolRuntimeContext,
  absolutePath: string,
): Promise<{ exists: boolean }> {
  const fileStat = await statIfExists(absolutePath);

  if (!fileStat) {
    return { exists: false };
  }

  if (!fileStat.isFile()) {
    throw new SatiToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
  }

  const snapshot = getWriteSnapshot(context, absolutePath);
  const normalizedMtime = Math.floor(fileStat.mtimeMs);
  const isFullRead = snapshot?.offset === undefined && snapshot?.limit === undefined;
  // 阶段四 T5：三态观测语义收敛到纯函数分类器；仅全量读且 mtime 不匹配时才
  // 读盘做内容哈希复核（避免额外 IO）。
  let hashMatches = false;
  if (snapshot !== undefined && isFullRead && normalizedMtime !== snapshot.mtimeMs) {
    hashMatches = hashText(await readTextFile(absolutePath)) === snapshot.contentHash;
  }
  const decision = classifyWriteIntent({
    path: absolutePath,
    snapshot,
    exists: true,
    mtimeMatches: snapshot !== undefined && normalizedMtime === snapshot.mtimeMs,
    hashMatches,
    fullRead: isFullRead,
  });
  if (decision.intent === "refuse") {
    throw new SatiToolRuntimeError(decision.code, decision.message, {
      absolutePath,
      expectedMtimeMs: snapshot?.mtimeMs,
      actualMtimeMs: normalizedMtime,
    });
  }
  return { exists: true };
}

export async function ensureWriteSnapshotFresh(
  context: SatiToolRuntimeContext,
  absolutePath: string,
): Promise<{ exists: boolean; previousContent: string | null; mtimeMs: number | null }> {
  const fileStat = await statIfExists(absolutePath);

  if (!fileStat) {
    return { exists: false, previousContent: null, mtimeMs: null };
  }

  if (!fileStat.isFile()) {
    throw new SatiToolRuntimeError("file_conflict", `${absolutePath} is not a regular file.`);
  }

  const snapshot = getWriteSnapshot(context, absolutePath);
  if (!snapshot) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      "File has not been read yet. Read it first before writing to it.",
    );
  }

  const normalizedMtime = Math.floor(fileStat.mtimeMs);
  const previousContent = await readTextFile(absolutePath);
  const isFullRead = snapshot.offset === undefined && snapshot.limit === undefined;
  const throwChanged = () =>
    new SatiToolRuntimeError(
      "invalid_tool_input",
      "File has changed since the last read. Read it again before writing to it.",
      {
        absolutePath,
        expectedMtimeMs: snapshot.mtimeMs,
        actualMtimeMs: normalizedMtime,
      },
    );

  if (normalizedMtime !== snapshot.mtimeMs) {
    if (isFullRead) {
      const currentHash = hashText(previousContent);
      if (currentHash === snapshot.contentHash) {
        return { exists: true, previousContent, mtimeMs: normalizedMtime };
      }
    }
    throw throwChanged();
  }

  if (!isFullRead) {
    return { exists: true, previousContent, mtimeMs: normalizedMtime };
  }

  const currentHash = hashText(previousContent);
  if (currentHash !== snapshot.contentHash) {
    throw throwChanged();
  }

  return { exists: true, previousContent, mtimeMs: normalizedMtime };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
