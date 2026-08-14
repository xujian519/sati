import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { TOOL_RESULTS_DIR_NAME, TOOL_RESULTS_REFS_DIR_NAME } from "./ProjectSessionStorage.js";

/** 孤儿 tool-results 目录默认宽限期：transcript 消失后 30 天。 */
export const DEFAULT_ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type ToolResultsCleanupOptions = {
  projectRoot: string;
  pilotHome: string;
  now?: () => Date;
  /** mtime 宽限期：目录在此时间内不动则视为仍可能被写入/引用。 */
  orphanGraceMs?: number;
  /** 仅统计不删除。 */
  dryRun?: boolean;
};

export type ToolResultsCleanupResult = {
  /** 已删除的孤儿会话目录数。 */
  removed: number;
  /** 保留的会话目录数（有 transcript 或仍在宽限期内）。 */
  retained: number;
  /** 被删除的会话目录名（sanitized session id）。 */
  removedIds: string[];
};

/**
 * 回收 `.sati/tool-results/` 下没有对应 transcript 的孤儿会话目录。
 *
 * transcript（`chats/<safeId>.jsonl`）是会话存在与可恢复的标志：
 * spill 的原文文件只被 transcript 中的 `tool_result_reference` 块引用，
 * transcript 消失即无引用（会话已删除或从未持久化）。因此白名单取
 * 磁盘 transcript 文件名集（含 always-on 内部会话——它们的 transcript
 * 是审计资产，tool-results 随之一并保留），白名单外的目录按 mtime
 * 宽限期（默认 30 天）回收，兜底「落盘后、transcript 写入前崩溃」的
 * 残留窗口。
 */
export async function cleanupOrphanToolResults(options: ToolResultsCleanupOptions): Promise<ToolResultsCleanupResult> {
  const toolResultsRoot = resolve(options.projectRoot, ".sati", TOOL_RESULTS_DIR_NAME);

  let names: string[];
  try {
    names = await readdir(toolResultsRoot);
  } catch {
    // 根目录不存在（从未 spill）或不可读 — 无孤儿。
    return { removed: 0, retained: 0, removedIds: [] };
  }

  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  let transcriptIds: Set<string>;
  try {
    const files = await readdir(chatDir);
    transcriptIds = new Set(files.filter(name => name.endsWith(".jsonl")).map(name => name.slice(0, -".jsonl".length)));
  } catch {
    // fail-closed：白名单读取失败时保留全部，绝不把可恢复会话误判为孤儿
    // （chatDir 与 tool-results 分属不同目录树，瞬时错误/配置漂移都可能触发）。
    return { removed: 0, retained: names.length, removedIds: [] };
  }

  const nowMs = (options.now?.() ?? new Date()).getTime();
  const graceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const removedIds: string[] = [];
  let retained = 0;

  for (const name of names) {
    // 跨会话共享的别名目录（read_file 取回通道），不属于任何单个会话，
    // 跳过以免 30 天闲置后误删全部会话的取回文件。
    if (name === TOOL_RESULTS_REFS_DIR_NAME) {
      retained += 1;
      continue;
    }
    if (transcriptIds.has(name)) {
      retained += 1;
      continue;
    }
    const dir = join(toolResultsRoot, name);
    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      entry = await stat(dir);
    } catch {
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (nowMs - entry.mtimeMs < graceMs) {
      retained += 1;
      continue;
    }
    removedIds.push(name);
    if (options.dryRun) {
      continue;
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort：单目录删除失败不影响其余回收。
    }
  }

  return { removed: removedIds.length, retained, removedIds };
}
