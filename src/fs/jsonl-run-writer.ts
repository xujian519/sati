import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 按 runId 复用的 JSONL 文件句柄写入器。
 *
 * 首次对某 runId 写入时 open('a') 并缓存句柄，后续直接 write——避免每条
 * 事件重复 mkdir + open/close（syscall 从每次 4 个降为 1 个 write）。tail
 * 串行链保证同一 runId 内事件顺序；`close` 显式收尾，未调用时由空闲 TTL
 * 兜底回收 fd（`unref` 不阻塞进程退出）。
 *
 * 供 always-on / cron 的 run 事件落盘复用（此前两份逐字重复的实现）。
 */

const DEFAULT_IDLE_TTL_MS = 60_000;

type RunWriter = {
  handle: FileHandle;
  /** 串行写队列：保证同一 run 内事件顺序，并让写入互相等待。 */
  tail: Promise<void>;
  lastWriteAt: number;
};

export type JsonlRunWriterOptions = {
  /** 空闲回收 TTL（毫秒）。默认 60_000。 */
  idleTtlMs?: number;
};

export type JsonlRunWriter = {
  /**
   * 追加一行（应含换行符）。同 runId 串行落盘，保持调用方 await 语义；
   * 单次写入失败不打断后续写入（错误由调用方决定是否吞掉）。
   */
  append(runId: string, line: string): Promise<void>;
  /** run 生命周期结束时主动关闭写入器（未调用则由空闲 TTL 兜底回收）。 */
  close(runId: string): Promise<void>;
};

export function createJsonlRunWriter(
  pathForRun: (runId: string) => string,
  options: JsonlRunWriterOptions = {},
): JsonlRunWriter {
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const runWriters = new Map<string, RunWriter>();
  let idleReaper: NodeJS.Timeout | undefined;

  const ensureIdleReaper = (): void => {
    if (idleReaper) return;
    idleReaper = setInterval(() => {
      const nowMs = Date.now();
      for (const [runId, writer] of runWriters) {
        if (nowMs - writer.lastWriteAt > idleTtlMs) {
          runWriters.delete(runId);
          void writer.tail.then(() => writer.handle.close()).catch(() => {});
        }
      }
      if (runWriters.size === 0 && idleReaper) {
        clearInterval(idleReaper);
        idleReaper = undefined;
      }
    }, idleTtlMs).unref();
  };

  const getRunWriter = async (runId: string): Promise<RunWriter> => {
    const existing = runWriters.get(runId);
    if (existing) return existing;
    const filePath = pathForRun(runId);
    await mkdir(dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    const writer: RunWriter = { handle, tail: Promise.resolve(), lastWriteAt: Date.now() };
    runWriters.set(runId, writer);
    ensureIdleReaper();
    return writer;
  };

  return {
    async append(runId, line) {
      const writer = await getRunWriter(runId);
      writer.lastWriteAt = Date.now();
      const write = writer.tail.then(() => writer.handle.write(Buffer.from(line, "utf-8"))).then(() => undefined);
      // 失败不打断写队列：后续事件继续尝试（错误由调用方 .catch 吞掉）。
      writer.tail = write.catch(() => undefined);
      await write;
    },
    async close(runId) {
      const writer = runWriters.get(runId);
      if (!writer) return;
      runWriters.delete(runId);
      await writer.tail;
      await writer.handle.close().catch(() => {});
    },
  };
}
